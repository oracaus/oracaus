import type {
  CausalMetadata,
  CoherenceKeyExtractor,
  CoherentSnapshot,
  GapEvent,
  GreeksUpdate,
  InstrumentId,
  PositionUpdate,
  PriceTick,
  SequencedCoherenceKeyExtractor,
  SequencedStreamConfig,
  StreamConfig,
  StreamId,
  StreamState,
} from "./types";
import { assertNever } from "./types";

// ─── Configuration ───────────────────────────────────────────────────────────

const REQUIRED_STREAMS: StreamId[] = ["prices", "positions", "greeks"];

type ResolvedStreamConfig = Required<StreamConfig>;

interface RenderGateConfigBase {
  /**
   * How long to wait (ms) for a causal key to arrive on all non-passThrough
   * streams before giving up and emitting a partial snapshot.
   *
   * Set to the p99 tail latency of the slowest service in your fan-out chain.
   * Falls back to wall-clock window semantics when no causal key is present.
   * @default 200
   */
  holdTimeout?: number;

  /**
   * Max spread (ms) between stream arrival times for wall-clock coherence.
   * Only used when coherenceKey returns null (uninstrumented feeds).
   * @default 50
   */
  wallClockWindow?: number;
}

/**
 * For non-sequenced feeds (byCorrelationId, byEventTimestamp, or no key).
 * gapStrategy is inactive — streams may omit it.
 */
interface StandardRenderGateConfig extends RenderGateConfigBase {
  coherenceKey?: CoherenceKeyExtractor;
  streams?: Partial<Record<StreamId, StreamConfig>>;
}

/**
 * For sequenced feeds (byGlobalSequence).
 * Every stream must declare a gapStrategy — each has different semantics
 * for what a missing sequence means (lost fill vs. stale reprice).
 */
interface SequencedRenderGateConfig extends RenderGateConfigBase {
  coherenceKey: SequencedCoherenceKeyExtractor;
  streams: Record<StreamId, SequencedStreamConfig>;
}

export type RenderGateConfig =
  | StandardRenderGateConfig
  | SequencedRenderGateConfig;

// ─── RenderGate ──────────────────────────────────────────────────────────────

/**
 * Guards the render loop against causally inconsistent snapshots.
 *
 * v0.1.0 asked: "did all streams update within the same time window?"
 * v0.2.0 asks:  "did all streams update in response to the same market event?"
 *
 * Time is a proxy for causality. It breaks in both directions:
 *   - Independent events arriving close together → false coherence
 *   - Related events fanning out slowly → false incoherence, blocked UI
 *
 * v0.2.0 identifies causality directly via correlationId / eventTimestamp /
 * globalSequence, with automatic wall-clock fallback for uninstrumented feeds.
 *
 * Why this matters:
 *   - Price & Risk:   a tradeable price must not appear alongside a breached limit.
 *   - Price & Greeks: fresh spot must not appear alongside stale hedge ratios.
 *   - Multi-venue:    partial positions must not trigger false limit breaches.
 *
 * passThrough controls per-stream freshness:
 *   false → invalid-if-stale: must carry the triggering causal key (positions, greeks).
 *   true  → valid-until-superseded: last known value is accepted (prices).
 */
export class RenderGate {
  private state: StreamState = {
    prices: {},
    positions: {},
    greeks: {},
    lastUpdated: { prices: 0, positions: 0, greeks: 0 },
    lastCausalId: { prices: null, positions: null, greeks: null },
    lastSequence: { prices: 0, positions: 0, greeks: 0 },
  };

  private sequenceId = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Causal key the gate is currently waiting on.
   * Set when a non-passThrough stream delivers a new key.
   * Cleared on any emit (coherent or partial) and on supersession.
   */
  private pendingCausalKey: string | null = null;

  /** Set when a sequence gap is detected; cleared only on a coherent emit. */
  private hasUnresolvedGap = false;

  private readonly streamConfigs: Record<StreamId, ResolvedStreamConfig>;
  private readonly holdTimeout: number;
  private readonly wallClockWindow: number;
  private readonly extractCausalKey:
    | CoherenceKeyExtractor
    | SequencedCoherenceKeyExtractor;
  private onGapCallback?: (event: GapEvent) => void;

  constructor(
    private readonly onSnapshot: (snapshot: CoherentSnapshot) => void,
    config: RenderGateConfig = {},
  ) {
    // ── Config variant note ──────────────────────────────────────────────────
    // config is StandardRenderGateConfig | SequencedRenderGateConfig. Both
    // produce identical runtime behaviour here — the distinction is enforced
    // at the call site by the SequencedCoherenceKeyExtractor brand on
    // byGlobalSequence, which makes `streams` required on every StreamId.
    //
    // The ?. accesses below are correct for StandardRenderGateConfig (streams
    // is optional). For SequencedRenderGateConfig the call site already
    // guarantees all streams are present, so the ?. is a no-op.
    //
    // ─────────────────────────────────────────────────────────────────────────
    this.holdTimeout = config.holdTimeout ?? 200;
    this.wallClockWindow = config.wallClockWindow ?? 50;
    this.extractCausalKey = config.coherenceKey ?? (() => null);

    this.streamConfigs = {
      prices: {
        passThrough: true,
        gapStrategy: "partial",
        ...config.streams?.prices,
      },
      positions: {
        passThrough: false,
        gapStrategy: "wait",
        ...config.streams?.positions,
      },
      greeks: {
        passThrough: false,
        gapStrategy: "wait",
        ...config.streams?.greeks,
      },
    };
  }

  /** Register a callback for sequence gap events (byGlobalSequence feeds only). */
  onGap(handler: (event: GapEvent) => void): void {
    this.onGapCallback = handler;
  }

  // ── Stream inlets ──────────────────────────────────────────────────────────

  /**
   * Ingest a conflated batch of price ticks from the BackpressureValve.
   *
   * Prices skip causal key checking (passThrough) and gap detection
   * (no checkSequence). Both are intentional:
   *   - passThrough: the last known price is valid without a matching key.
   *   - No gap detection: the BackpressureValve conflates intermediate ticks
   *     by design, making per-tick sequences meaningless and gaps false alarms.
   *
   * Empty metadata is passed to tryEmit so the extractor returns null,
   * routing through wall-clock — prevents a price-only update from triggering
   * a causal emit.
   */
  updatePrices(ticks: Map<InstrumentId, PriceTick>): void {
    for (const [id, tick] of ticks) this.state.prices[id] = tick;
    this.state.lastUpdated.prices = Date.now();
    this.tryEmit({});
  }

  updatePositions(update: PositionUpdate): void {
    if (!this.checkSequence("positions", update)) return;
    this.state.positions[update.instrumentId] = update;
    this.state.lastUpdated.positions = Date.now();
    this.updateCausalId("positions", update);
    this.tryEmit(update);
  }

  updateGreeks(update: GreeksUpdate): void {
    if (!this.checkSequence("greeks", update)) return;
    this.state.greeks[update.instrumentId] = update;
    this.state.lastUpdated.greeks = Date.now();
    this.updateCausalId("greeks", update);
    this.tryEmit(update);
  }

  // ── Causal key tracking ────────────────────────────────────────────────────

  /**
   * Store the causal key at the update site rather than re-extracting it
   * later from stored messages — avoids a fragile getLastMessage() pattern.
   */
  private updateCausalId(streamId: StreamId, msg: CausalMetadata): void {
    if (this.streamConfigs[streamId].passThrough) return;
    const key = this.extractCausalKey(msg);
    if (key !== null) {
      this.state.lastCausalId[streamId] = key;
    }
  }

  // ── Gap detection ──────────────────────────────────────────────────────────

  /**
   * Detect sequence gaps on globalSequence feeds. Always returns true —
   * the message that revealed the gap is valid; the problem is the missing
   * message before it.
   *
   * Per gapStrategy:
   *   'wait'           — set hasUnresolvedGap, arm hold timer.
   *   'snapshot-fetch' — same, plus fire onGap so the orchestrator can fetch.
   *   'partial'        — advance past the gap silently; latest value wins.
   */
  private checkSequence(streamId: StreamId, msg: CausalMetadata): boolean {
    if (msg.globalSequence == null) return true;

    const last = this.state.lastSequence[streamId];
    const seq = msg.globalSequence;

    if (last > 0 && seq !== last + 1) {
      const gap: GapEvent = {
        stream: streamId,
        expectedSeq: last + 1,
        receivedSeq: seq,
      };

      const strategy = this.streamConfigs[streamId].gapStrategy;

      switch (strategy) {
        case "snapshot-fetch":
          this.onGapCallback?.(gap);
          this.hasUnresolvedGap = true;
          this.armHoldTimer();
          break;
        case "wait":
          this.hasUnresolvedGap = true;
          this.armHoldTimer();
          break;
        case "partial":
          // Latest value supersedes the missing one — snapshot is not degraded.
          break;
        default:
          assertNever(strategy);
      }
    }

    this.state.lastSequence[streamId] = seq;
    return true;
  }

  // ── Core gate logic ────────────────────────────────────────────────────────

  /**
   * Route to causal or wall-clock coherence based on whether the triggering
   * message carries a causal key.
   */
  private tryEmit(triggeringMsg: CausalMetadata): void {
    const causalKey = this.extractCausalKey(triggeringMsg);

    if (causalKey !== null) {
      this.tryEmitCausal(causalKey);
    } else {
      this.tryEmitWallClock();
    }
  }

  /**
   * Identity-based coherence (primary path).
   *
   * Three cases:
   *   No pending key       → adopt key, check coherence, emit or arm timer.
   *   Same key as pending  → recheck (another stream may have just caught up).
   *   Different key        → supersession: emit partial for the stale key,
   *                          adopt the new one, recheck.
   */
  private tryEmitCausal(causalKey: string): void {
    if (this.pendingCausalKey !== null && this.pendingCausalKey !== causalKey) {
      // New event arrived before the previous one resolved — emit partial and move on.
      this.clearHoldTimer();
      this.emit(true);
    }

    this.pendingCausalKey = causalKey;

    if (this.isCoherentForKey(causalKey)) {
      this.clearHoldTimer();
      this.pendingCausalKey = null;
      this.emit(this.hasUnresolvedGap);
      this.hasUnresolvedGap = false;
    } else {
      this.armHoldTimer();
    }
  }

  /**
   * Wall-clock coherence (fallback path).
   * Active when the extractor returns null — feed is uninstrumented or the
   * relevant metadata field is absent from this message.
   *
   * Clears pendingCausalKey on coherent emit: a wall-clock resolution closes
   * any in-flight causal wait. Without this, a late delivery of the pending
   * key would re-enter tryEmitCausal and emit a second snapshot for the same event.
   */
  private tryEmitWallClock(): void {
    if (this.isWallClockCoherent()) {
      this.clearHoldTimer();
      this.pendingCausalKey = null;
      this.emit(this.hasUnresolvedGap);
      this.hasUnresolvedGap = false;
    } else {
      this.armHoldTimer();
    }
  }

  // ── Coherence checks ──────────────────────────────────────────────────────

  /**
   * True when every required stream is ready for the given key.
   *
   * passThrough streams: any historical update suffices (valid-until-superseded).
   * non-passThrough streams: lastCausalId must match exactly (invalid-if-stale).
   *
   * This is the consistent-cut condition from Chandy-Lamport: has every
   * channel delivered its marker? The causal key is the marker.
   */
  private isCoherentForKey(causalKey: string): boolean {
    for (const streamId of REQUIRED_STREAMS) {
      const config = this.streamConfigs[streamId];

      if (config.passThrough) {
        if (this.state.lastUpdated[streamId] === 0) return false;
      } else {
        if (this.state.lastCausalId[streamId] !== causalKey) return false;
      }
    }
    return true;
  }

  /**
   * True when all streams have data and their arrival times are within
   * wallClockWindow ms of each other.
   */
  private isWallClockCoherent(): boolean {
    const times = REQUIRED_STREAMS.map((s) => this.state.lastUpdated[s]);
    if (times.some((t) => t === 0)) return false;
    const min = Math.min(...times);
    const max = Math.max(...times);
    return max - min <= this.wallClockWindow;
  }

  // ── Timer management ───────────────────────────────────────────────────────

  /**
   * Start the hold timer. On expiry, emit partial — the gate has waited as
   * long as operationally justified and must not block the UI further.
   *
   * Does not clear hasUnresolvedGap: a timeout means the missing data never
   * arrived. Only a confirmed coherent delivery should clear the gap flag;
   * clearing it here would let subsequent snapshots appear clean over a hole.
   */
  private armHoldTimer(): void {
    if (this.holdTimer !== null) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.pendingCausalKey = null;
      this.emit(true);
    }, this.holdTimeout);
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  // ── Emit ───────────────────────────────────────────────────────────────────

  private emit(isPartial: boolean): void {
    this.onSnapshot({
      prices: { ...this.state.prices },
      positions: { ...this.state.positions },
      greeks: { ...this.state.greeks },
      sequenceId: ++this.sequenceId,
      renderedAt: Date.now(),
      isPartial,
    });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  destroy(): void {
    this.clearHoldTimer();
    this.onGapCallback = undefined;
  }
}
