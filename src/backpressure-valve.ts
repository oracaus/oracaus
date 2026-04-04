import type { InstrumentId, PriceTick, RenderPriority } from "./types";

const TARGET_FPS = 60;
const FRAME_BUDGET_MS = 1000 / TARGET_FPS; // ~16.67ms

/**
 * The Backpressure Valve
 *
 * Backend engineers know rate limiting and load shedding.
 * Client engineers discover the need for them during a volatility event
 * when the browser freezes for five seconds.
 *
 * Three-stage filter pipeline:
 *
 *  [2,000 ticks/sec inbound]
 *        │
 *        ▼
 *  1. Active Monitoring Filter — drop instruments not being watched
 *        │
 *        ▼
 *  2. Viewport Filter — classify priority by screen position
 *        │
 *        ▼
 *  3. Human Perception Filter — conflate and throttle to 60fps
 *        │
 *        ▼
 *  [Render Loop]
 */
export class BackpressureValve {
  private watched = new Set<InstrumentId>();
  private viewport = new Set<InstrumentId>();
  private active = new Set<InstrumentId>();

  // Latest tick per instrument — older ticks are overwritten (conflation)
  private pending = new Map<InstrumentId, PriceTick>();
  private lastEmit = new Map<InstrumentId, number>();
  private frameHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onFlush: (ticks: Map<InstrumentId, PriceTick>) => void,
  ) {}

  // ── Subscription control ────────────────────────────────────────────────────

  addWatched(ids: InstrumentId[]): void {
    ids.forEach((id) => this.watched.add(id));
  }

  removeWatched(ids: InstrumentId[]): void {
    ids.forEach((id) => {
      this.watched.delete(id);
      this.pending.delete(id);
    });
  }

  setViewport(ids: InstrumentId[]): void {
    this.viewport = new Set(ids);
  }

  setActive(id: InstrumentId, isActive: boolean): void {
    isActive ? this.active.add(id) : this.active.delete(id);
  }

  // ── Ingestion ───────────────────────────────────────────────────────────────

  ingest(tick: PriceTick): void {
    const { instrumentId: id } = tick;

    // Stage 1: Active Monitoring Filter
    if (!this.watched.has(id)) return;

    const priority = this.classify(id);

    // Stage 2: Viewport Filter — drop passive off-screen entirely
    if (priority === "drop") return;

    // Conflate: newest tick wins for this instrument
    this.pending.set(id, tick);

    // Stage 3: schedule flush according to priority
    if (priority === "high") {
      this.scheduleFlush(0); // next microtask
    } else if (priority === "medium") {
      this.scheduleFlush(FRAME_BUDGET_MS);
    }
    // 'low' — accumulates in pending; flushed on next scheduled frame
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * Render Budget Prioritization Matrix
   *
   *               Off-screen  │  In Viewport
   *  Active           low     │      high
   *  Passive          DROP    │     medium
   */
  private classify(id: InstrumentId): RenderPriority {
    const inViewport = this.viewport.has(id);
    const isActive = this.active.has(id);

    if (inViewport && isActive) return "high";
    if (inViewport && !isActive) return "medium";
    if (!inViewport && isActive) return "low";
    return "drop";
  }

  private scheduleFlush(delayMs: number): void {
    if (this.frameHandle !== null) return;
    this.frameHandle = setTimeout(() => {
      this.frameHandle = null;
      this.flush();
    }, delayMs);
  }

  private flush(): void {
    if (this.pending.size === 0) return;

    const now = Date.now();
    const toEmit = new Map<InstrumentId, PriceTick>();

    for (const [id, tick] of this.pending) {
      const last = this.lastEmit.get(id) ?? 0;
      if (now - last >= FRAME_BUDGET_MS) {
        toEmit.set(id, tick);
        this.lastEmit.set(id, now);
        this.pending.delete(id);
      }
    }

    if (toEmit.size > 0) this.onFlush(toEmit);
  }

  destroy(): void {
    if (this.frameHandle !== null) clearTimeout(this.frameHandle);
  }
}
