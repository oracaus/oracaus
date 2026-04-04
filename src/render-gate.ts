import type {
  CoherentSnapshot,
  StreamId,
  StreamState,
  InstrumentId,
  PriceTick,
  PositionUpdate,
  GreeksUpdate,
} from "./types";

/**
 * Coherence window: the maximum acceptable timestamp delta between streams.
 * If Price arrived at T and Position arrived at T+45ms we consider them coherent.
 * If the gap exceeds this threshold the gate holds the render.
 */
const COHERENCE_WINDOW_MS = 50;

/**
 * If a stream is genuinely lagging (network partition, slow feed), we must
 * eventually render rather than block the UI forever. After this grace period
 * the gate emits a partial (potentially incoherent) snapshot.
 */
const MAX_HOLD_MS = COHERENCE_WINDOW_MS * 4; // 200ms

const REQUIRED_STREAMS: StreamId[] = ["prices", "positions", "greeks"];

/**
 * The Render Gate
 *
 * The problem: mixing a t+1 price with a t+0 position produces a
 * mathematically invalid P&L. Not stale. Not slow. Internally inconsistent.
 *
 * Faster rendering makes this WORSE — without a gate, a 60fps render loop
 * eagerly paints whatever arrives first, maximising the chance of showing
 * data points that were never valid at the same moment in time.
 *
 * Three critical use cases:
 *  - Price & Risk:  prevents a tradeable price on a line already breached
 *                   by a lagging risk notification.
 *  - Price & Greeks: prevents a fresh spot price alongside stale hedge ratios.
 *  - Multi-venue: prevents partial positions triggering false risk limits.
 *
 * The gate emits only when all required streams are within COHERENCE_WINDOW_MS
 * of each other, or when MAX_HOLD_MS has elapsed (partial snapshot, clearly
 * flagged as isPartial: true).
 */
export class RenderGate {
  private state: StreamState = {
    prices: {},
    positions: {},
    greeks: {},
    lastUpdated: { prices: 0, positions: 0, greeks: 0 },
  };

  private sequenceId = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onSnapshot: (snapshot: CoherentSnapshot) => void,
  ) {}

  // ── Stream inlets ───────────────────────────────────────────────────────────

  updatePrices(ticks: Map<InstrumentId, PriceTick>): void {
    for (const [id, tick] of ticks) this.state.prices[id] = tick;
    this.state.lastUpdated.prices = Date.now();
    this.tryEmit();
  }

  updatePositions(update: PositionUpdate): void {
    this.state.positions[update.instrumentId] = update;
    this.state.lastUpdated.positions = Date.now();
    this.tryEmit();
  }

  updateGreeks(update: GreeksUpdate): void {
    this.state.greeks[update.instrumentId] = update;
    this.state.lastUpdated.greeks = Date.now();
    this.tryEmit();
  }

  // ── Gate logic ──────────────────────────────────────────────────────────────

  private tryEmit(): void {
    if (this.isCoherent()) {
      // Happy path — all streams in sync, emit immediately
      if (this.holdTimer) {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
      this.emit(false);
    } else {
      // Arm the safety-valve timer if not already running
      if (this.holdTimer === null) {
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null;
          this.emit(true); // partial — flag it
        }, MAX_HOLD_MS);
      }
    }
  }

  private isCoherent(): boolean {
    const times = REQUIRED_STREAMS.map((s) => this.state.lastUpdated[s]);

    // All streams must have received at least one update
    if (times.some((t) => t === 0)) return false;

    const min = Math.min(...times);
    const max = Math.max(...times);
    return max - min <= COHERENCE_WINDOW_MS;
  }

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

  destroy(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
  }
}
