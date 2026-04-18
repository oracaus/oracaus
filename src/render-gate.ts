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

  /**
   * The non-passThrough stream that defines each instrument's reference key.
   * Other non-passThrough streams are evaluated against the anchor per their
   * `freshness` setting: "match" requires equal keys, "monotonic" requires
   * key ≥ anchor's key.
   *
   * Required in every config (v0.4.0 breaking change). The wall-clock
   * fallback path ignores it.
   */
  anchorStream: StreamId;
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
 * v0.2.0 asked: "did all streams update in response to the same market event?"
 *               (stream-level: one pendingCausalKey globally)
 * v0.3.0 asks:  "did all streams update in response to the same market event,
 *               per instrument?"
 *               (per-instrument: one pendingCausalKey per InstrumentId)
 *
 * The v0.2.0 stream-level gate broke on multi-instrument blotters: AAPL on
 * "FILL-456" and GOOG on "FILL-789" caused mutual supersession — neither
 * instrument ever reached coherence. v0.3.0 tracks causal state independently
 * per instrument so AAPL and GOOG resolve without interference.
 *
 * CoherentSnapshot.coherentInstruments reports which instruments are causally
 * matched at each emit, enabling per-row staleness indicators and safe
 * cross-currency P&L aggregation (only include coherent instruments).
 *
 * passThrough controls per-stream freshness:
 *   false → invalid-if-stale: must carry the triggering causal key (positions, greeks).
 *   true  → valid-until-superseded: last known value is accepted (prices).
 *
 * Emit policy: the gate is silent while waiting for causal resolution.
 * It emits only on coherent resolution (any instrument) or on timer expiry.
 * The wall-clock path emits when the stream-level timing window is satisfied.
 *
 * Wall-clock fallback remains stream-level (not per-instrument). It is the
 * explicitly degraded mode for uninstrumented feeds; per-instrument wall-clock
 * tracking remains a future concern (not addressed in v0.4.0 — freshness
 * semantics only affect the causal path).
 */
export class RenderGate {
  private state: StreamState = {
    prices: {},
    positions: {},
    greeks: {},
    lastUpdated: { prices: 0, positions: 0, greeks: 0 },
    lastCausalId: { prices: {}, positions: {}, greeks: {} },
    lastSequence: { prices: {}, positions: {}, greeks: {} },
  };

  private sequenceId = 0;

  /**
   * Per-instrument causal key currently being waited on.
   * An entry exists iff the instrument has a non-passThrough update with a
   * non-null causal key that has not yet resolved across all required streams.
   */
  private pendingCausalKeys = new Map<InstrumentId, string>();

  /**
   * Per-instrument hold timers. One timer per instrument waiting for its
   * non-passThrough streams to deliver a matching causal key.
   */
  private holdTimers = new Map<InstrumentId, ReturnType<typeof setTimeout>>();

  /**
   * Per-instrument unresolved gap flag. Set when a sequence gap is detected
   * for that instrument. Cleared on the first coherent delivery for that
   * instrument — clearing it on timeout would let subsequent snapshots appear
   * clean over a data hole.
   */
  private hasUnresolvedGaps = new Set<InstrumentId>();

  /**
   * Instruments that should make the next emit partial. Populated by:
   *   - Hold timer expiry (gate gave up waiting for causal resolution).
   *   - Coherent delivery after an unresolved gap (gap consumed, data missing).
   * Cleared immediately inside emit() after consumption.
   */
  private partialThisCycle = new Set<InstrumentId>();

  /**
   * Incrementally maintained coherent set (causal path only).
   * An instrument is in this set when it has resolved its causal key across
   * all required streams and is not currently pending a new key.
   *
   * Updated at each state transition rather than rebuilt on every emit(),
   * keeping emit() O(1) instead of O(N) for the causal path.
   * The wall-clock path recomputes from state directly (stream-level semantics).
   */
  private _coherentInstruments = new Set<InstrumentId>();

  private readonly streamConfigs: Record<StreamId, ResolvedStreamConfig>;
  private readonly holdTimeout: number;
  private readonly wallClockWindow: number;
  private readonly extractCausalKey:
    | CoherenceKeyExtractor
    | SequencedCoherenceKeyExtractor;
  /** The non-passThrough stream that defines each instrument's reference key. */
  private readonly anchorStream: StreamId;
  /** True iff any non-passThrough stream declares `freshness: "monotonic"`. */
  private readonly hasMonotonicFreshness: boolean;
  /** Strategy-aware key comparator, present when the extractor supports ordering. */
  private readonly compareKeys:
    | ((a: string, b: string) => -1 | 0 | 1)
    | undefined;
  private onGapCallback?: (event: GapEvent) => void;

  constructor(
    private readonly onSnapshot: (snapshot: CoherentSnapshot) => void,
    config: RenderGateConfig,
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
    // ─────────────────────────────────────────────────────────────────────────
    this.holdTimeout = config.holdTimeout ?? 200;
    this.wallClockWindow = config.wallClockWindow ?? 50;
    this.extractCausalKey = config.coherenceKey ?? (() => null);

    this.streamConfigs = {
      prices: {
        passThrough: true,
        freshness: "match",
        gapStrategy: "partial",
        ...config.streams?.prices,
      },
      positions: {
        passThrough: false,
        freshness: "match",
        gapStrategy: "wait",
        ...config.streams?.positions,
      },
      greeks: {
        passThrough: false,
        freshness: "match",
        gapStrategy: "wait",
        ...config.streams?.greeks,
      },
    };

    this.compareKeys = (
      config.coherenceKey as CoherenceKeyExtractor | undefined
    )?.compare;

    this.hasMonotonicFreshness = REQUIRED_STREAMS.some(
      (s) => this.streamConfigs[s].freshness === "monotonic",
    );

    // ── Runtime validation ───────────────────────────────────────────────────
    // Type-level narrowing of `freshness` per extractor and of `anchorStream`
    // (passThrough / unknown) is scheduled for v0.5.0 — see CHANGELOG v0.5.0
    // impl note 10. When that lands, the three `throw` sites below should all
    // become compile errors and this entire validation block can be deleted.
    // The v0.4.0 TypeScript surface stays permissive (match | monotonic on any
    // extractor, any declared StreamId as anchor) but the gate refuses to run
    // an invalid combination.
    // ─────────────────────────────────────────────────────────────────────────
    if (this.hasMonotonicFreshness) {
      if (this.compareKeys === undefined) {
        throw new Error(
          'freshness: "monotonic" requires an ordered coherence key extractor ' +
            "(byEventTimestamp or byGlobalSequence). byCorrelationId has no ordering.",
        );
      }
      for (const s of REQUIRED_STREAMS) {
        if (
          this.streamConfigs[s].freshness === "monotonic" &&
          this.streamConfigs[s].passThrough
        ) {
          throw new Error(
            `Stream "${s}" is passThrough — freshness has no effect on passThrough streams.`,
          );
        }
      }
    }

    if (!REQUIRED_STREAMS.includes(config.anchorStream)) {
      throw new Error(
        `anchorStream "${config.anchorStream}" is not a declared stream.`,
      );
    }
    if (this.streamConfigs[config.anchorStream].passThrough) {
      throw new Error(
        `anchorStream "${config.anchorStream}" is passThrough — ` +
          "the anchor must be a non-passThrough stream.",
      );
    }
    this.anchorStream = config.anchorStream;
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
   * Price updates may satisfy a pending wall-clock wait. If all streams are
   * now within the window, emit. If not, don't arm a timer — a timer will be
   * armed when positions/greeks arrive (they're the non-passThrough signals).
   */
  updatePrices(ticks: Map<InstrumentId, PriceTick>): void {
    for (const [id, tick] of ticks) this.state.prices[id] = tick;
    this.state.lastUpdated.prices = Date.now();
    if (this.isWallClockCoherent()) {
      for (const id of [...this.holdTimers.keys()]) this.clearHoldTimer(id);
      this.pendingCausalKeys.clear();
      this.emit();
    }
  }

  updatePositions(update: PositionUpdate): void {
    if (!this.checkSequence("positions", update.instrumentId, update)) return;
    this.state.positions[update.instrumentId] = update;
    this.state.lastUpdated.positions = Date.now();
    this.updateCausalId("positions", update.instrumentId, update);
    this.tryEmit(update.instrumentId, update);
  }

  updateGreeks(update: GreeksUpdate): void {
    if (!this.checkSequence("greeks", update.instrumentId, update)) return;
    this.state.greeks[update.instrumentId] = update;
    this.state.lastUpdated.greeks = Date.now();
    this.updateCausalId("greeks", update.instrumentId, update);
    this.tryEmit(update.instrumentId, update);
  }

  // ── Causal key tracking ────────────────────────────────────────────────────

  /**
   * Store the causal key at the update site rather than re-extracting it
   * later from stored messages — avoids a fragile getLastMessage() pattern.
   */
  private updateCausalId(
    streamId: StreamId,
    instrumentId: InstrumentId,
    msg: CausalMetadata,
  ): void {
    if (this.streamConfigs[streamId].passThrough) return;
    const key = this.extractCausalKey(msg);
    if (key !== null) {
      this.state.lastCausalId[streamId][instrumentId] = key;
    }
  }

  // ── Gap detection ──────────────────────────────────────────────────────────

  /**
   * Detect sequence gaps on globalSequence feeds, per instrument. Always
   * returns true — the message that revealed the gap is valid; the problem
   * is the missing message before it.
   *
   * Per gapStrategy:
   *   'wait'           — set hasUnresolvedGaps for this instrument, arm timer.
   *   'snapshot-fetch' — same, plus fire onGap so the orchestrator can fetch.
   *   'partial'        — advance past the gap silently; latest value wins.
   *
   * Gap detection is per-instrument: AAPL jumping seq 1→3 is an AAPL-specific
   * problem and does not affect GOOG's sequence tracking.
   */
  private checkSequence(
    streamId: StreamId,
    instrumentId: InstrumentId,
    msg: CausalMetadata,
  ): boolean {
    if (msg.globalSequence == null) return true;

    const seq = msg.globalSequence;
    const last = this.state.lastSequence[streamId][instrumentId] ?? 0;

    if (last > 0 && seq !== last + 1) {
      const gap: GapEvent = {
        stream: streamId,
        instrumentId,
        expectedSeq: last + 1,
        receivedSeq: seq,
      };

      const strategy = this.streamConfigs[streamId].gapStrategy;

      switch (strategy) {
        case "snapshot-fetch":
          this.onGapCallback?.(gap);
          this.hasUnresolvedGaps.add(instrumentId);
          this._coherentInstruments.delete(instrumentId);
          this.armHoldTimer(instrumentId);
          break;
        case "wait":
          this.hasUnresolvedGaps.add(instrumentId);
          this._coherentInstruments.delete(instrumentId);
          this.armHoldTimer(instrumentId);
          break;
        case "partial":
          // Latest value supersedes the missing one — snapshot is not degraded.
          break;
        default:
          assertNever(strategy);
      }
    }

    this.state.lastSequence[streamId][instrumentId] = seq;
    return true;
  }

  // ── Core gate logic ────────────────────────────────────────────────────────

  /**
   * Route to causal or wall-clock coherence based on whether the triggering
   * message carries a causal key. Called for position and greeks updates.
   */
  private tryEmit(
    instrumentId: InstrumentId,
    triggeringMsg: CausalMetadata,
  ): void {
    const causalKey = this.extractCausalKey(triggeringMsg);

    if (causalKey !== null) {
      this.tryEmitCausal(instrumentId, causalKey);
    } else {
      this.tryEmitWallClock(instrumentId);
    }
  }

  /**
   * Identity-based coherence (primary path), per instrument.
   *
   * Three cases for this instrument:
   *   No pending key       → adopt key, check coherence, emit or arm timer.
   *   Same key as pending  → recheck (another stream may have just caught up).
   *   Different key        → supersession: replace the pending key silently,
   *                          recheck with the new key. No immediate partial emit
   *                          — coherentInstruments on the next regular emit
   *                          implicitly signals that this instrument is in-flight.
   *
   * Supersessions for instrument A do not affect instrument B's pending state.
   * This is the core v0.3.0 fix over v0.2.0 stream-level tracking.
   *
   * The gate is silent while waiting. It emits only when:
   *   - This instrument reaches coherence (causal key matched on all streams).
   *   - The hold timer fires (see armHoldTimer).
   */
  private tryEmitCausal(instrumentId: InstrumentId, causalKey: string): void {
    // Supersession is driven by the anchor's current key, not the triggering
    // stream's — a monotonic dependent advancing past the anchor is not a
    // supersession event. When the anchor hasn't delivered yet, fall back to
    // the triggering key so the hold timer still arms (and fires partial) if
    // the anchor never arrives.
    const pendingKey =
      this.state.lastCausalId[this.anchorStream][instrumentId] ?? causalKey;

    const existingKey = this.pendingCausalKeys.get(instrumentId);

    if (existingKey !== undefined && existingKey !== pendingKey) {
      // Supersession for this instrument only. Clear the old timer and adopt
      // the new key. No partial emit — the new key may resolve quickly, and
      // coherentInstruments on the next emit implicitly signals in-flight state.
      this.clearHoldTimer(instrumentId);
      this._coherentInstruments.delete(instrumentId);
    }

    this.pendingCausalKeys.set(instrumentId, pendingKey);

    if (this.isInstrumentCoherent(instrumentId)) {
      this.clearHoldTimer(instrumentId);
      this.pendingCausalKeys.delete(instrumentId);
      // Consume the gap flag: this coherent delivery is the first clean snapshot
      // after the gap. Mark partial so consumers know history has a hole, then
      // clear so subsequent emits are clean.
      if (this.hasUnresolvedGaps.has(instrumentId)) {
        this.partialThisCycle.add(instrumentId);
        this.hasUnresolvedGaps.delete(instrumentId);
      }
      this._coherentInstruments.add(instrumentId);
      this.emit();
    } else {
      // Membership must track the post-update coherence state. Without this,
      // a previously-coherent instrument whose anchor just advanced past a
      // monotonic dependent (or whose key changed under match without a
      // pre-existing pending) would linger in the set until the next supersession.
      this._coherentInstruments.delete(instrumentId);
      this.armHoldTimer(instrumentId);
    }
  }

  /**
   * Wall-clock coherence (fallback path), called when the triggering message
   * carries no causal key.
   *
   * If the stream-level timing window is satisfied, emit and clear any pending
   * causal state — a wall-clock resolution closes any in-flight causal wait.
   * Without this, a late delivery of a pending key would re-enter
   * tryEmitCausal and emit a second snapshot for the same event.
   *
   * If not yet coherent, arm a per-instrument hold timer so we can emit
   * partial after holdTimeout if the feed never becomes coherent.
   *
   * Operates at stream level (not per-instrument) — this is the documented
   * limitation of the wall-clock fallback. All instruments with data on all
   * streams are added to coherentInstruments as a group.
   */
  private tryEmitWallClock(instrumentId: InstrumentId): void {
    if (this.isWallClockCoherent()) {
      // Clear all per-instrument causal state — wall-clock coherence resolves
      // any pending causal waits across all instruments.
      for (const id of [...this.holdTimers.keys()]) this.clearHoldTimer(id);
      this.pendingCausalKeys.clear();
      this.emit();
    } else {
      // Not coherent yet. Arm a timer for this instrument so we emit partial
      // after holdTimeout if the feed never converges.
      this.armHoldTimer(instrumentId);
    }
  }

  // ── Coherence checks ──────────────────────────────────────────────────────

  /**
   * True when every required stream is ready for the given instrument.
   *
   * passThrough streams: any historical update suffices (valid-until-superseded).
   * non-passThrough streams: governed by `freshness` relative to the anchor:
   *   - "match" (default): stream's causal key must equal the anchor's key.
   *   - "monotonic": stream's key must be ≥ the anchor's key per the extractor's
   *     `compare` function. Requires an ordered extractor (validated at construction).
   */
  private isInstrumentCoherent(instrumentId: InstrumentId): boolean {
    const anchorKey = this.state.lastCausalId[this.anchorStream][instrumentId];
    if (anchorKey === undefined) return false;

    for (const streamId of REQUIRED_STREAMS) {
      const config = this.streamConfigs[streamId];

      if (config.passThrough) {
        if (this.state[streamId][instrumentId] === undefined) return false;
        continue;
      }

      if (streamId === this.anchorStream) continue; // anchor is its own reference

      const streamKey = this.state.lastCausalId[streamId][instrumentId];
      if (streamKey === undefined) return false;

      if (config.freshness === "monotonic") {
        // compareKeys is guaranteed non-undefined for monotonic streams —
        // the constructor rejects monotonic without an ordered extractor.
        if (
          this.compareKeys === undefined ||
          this.compareKeys(streamKey, anchorKey) < 0
        ) {
          return false;
        }
      } else if (streamKey !== anchorKey) {
        return false;
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
   * Start the hold timer for a specific instrument. On expiry, emit partial —
   * the gate has waited as long as operationally justified for this instrument.
   *
   * partialThisCycle is set so the next emit() call marks isPartial = true.
   * hasUnresolvedGaps is NOT cleared on timeout — only a coherent delivery
   * should clear it. Clearing it here would let subsequent snapshots appear
   * clean over a data hole.
   */
  private armHoldTimer(instrumentId: InstrumentId): void {
    if (this.holdTimers.has(instrumentId)) return;
    const timer = setTimeout(() => {
      this.holdTimers.delete(instrumentId);
      this.pendingCausalKeys.delete(instrumentId);
      this._coherentInstruments.delete(instrumentId);
      this.partialThisCycle.add(instrumentId);
      this.emit();
    }, this.holdTimeout);
    this.holdTimers.set(instrumentId, timer);
  }

  private clearHoldTimer(instrumentId: InstrumentId): void {
    const timer = this.holdTimers.get(instrumentId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.holdTimers.delete(instrumentId);
    }
  }

  // ── Emit ───────────────────────────────────────────────────────────────────

  /**
   * Emit a snapshot.
   *
   * Wall-clock path: recomputes coherentInstruments from state — all instruments
   * with data on every required stream are coherent (v0.1.0 stream-level semantics).
   * O(N) scan is acceptable here: the wall-clock path is the degraded fallback for
   * uninstrumented feeds, not the hot path.
   *
   * Causal path: copies _coherentInstruments, which is maintained incrementally at
   * each state transition (coherence, supersession, hold timeout, gap). O(1) per
   * emit, making the causal path O(N) total for an N-instrument rebalance instead
   * of the previous O(N²).
   *
   * isPartial = true iff partialThisCycle is non-empty, meaning:
   *   - A hold timer fired for ≥1 instrument (gate gave up on causal resolution), OR
   *   - A coherent delivery resolved after a known sequence gap (data hole exists).
   * partialThisCycle is cleared immediately after consumption.
   */
  private emit(): void {
    const wallClockCoherent = this.isWallClockCoherent();

    let coherentInstruments: Set<InstrumentId>;

    if (wallClockCoherent) {
      // Wall-clock fallback: scan all known instruments (stream-level semantics).
      coherentInstruments = new Set<InstrumentId>();
      const allInstruments = new Set<InstrumentId>([
        ...Object.keys(this.state.positions),
        ...Object.keys(this.state.greeks),
      ]);
      for (const id of allInstruments) {
        if (this.hasInstrumentDataWallClock(id)) coherentInstruments.add(id);
      }
    } else {
      // Causal path: O(1) — copy the incrementally maintained set.
      coherentInstruments = new Set(this._coherentInstruments);
    }

    const isPartial = this.partialThisCycle.size > 0;
    this.partialThisCycle.clear();

    this.onSnapshot({
      prices: { ...this.state.prices },
      positions: { ...this.state.positions },
      greeks: { ...this.state.greeks },
      sequenceId: ++this.sequenceId,
      renderedAt: Date.now(),
      coherentInstruments,
      isPartial,
    });
  }

  /**
   * True when the instrument has actual data on every required stream.
   * Used in the wall-clock path — wall-clock deliveries don't populate
   * lastCausalId, so we check the data stores directly.
   */
  private hasInstrumentDataWallClock(instrumentId: InstrumentId): boolean {
    for (const streamId of REQUIRED_STREAMS) {
      if (this.state[streamId][instrumentId] === undefined) return false;
    }
    return true;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  destroy(): void {
    for (const timer of this.holdTimers.values()) clearTimeout(timer);
    this.holdTimers.clear();
    this._coherentInstruments.clear();
    this.onGapCallback = undefined;
  }
}
