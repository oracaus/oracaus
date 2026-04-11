// ─── Domain primitives ───────────────────────────────────────────────────────

export type InstrumentId = string;
export type StreamId = "prices" | "positions" | "greeks";

// ─── Causal metadata ─────────────────────────────────────────────────────────

/**
 * Stamp exactly one field per message, chosen by feed type:
 *   correlationId  → event-driven fan-out (fills, risk events)
 *   eventTimestamp → exchange-timestamped feeds
 *   globalSequence → sequenced feeds (Solace, AMPS)
 *
 * All fields are optional — the gate falls back to wall-clock when all are absent.
 */
export interface CausalMetadata {
  /** Shared by all messages produced by the same market event. */
  correlationId?: string;

  /**
   * Exchange time of the originating event (ms UTC).
   * Must be exchange time — server or client processing time corrupts the signal.
   */
  eventTimestamp?: number;

  /**
   * Monotonically increasing sequence number spanning all streams on one feed.
   * Enables gap detection. Supported natively by Solace and AMPS.
   */
  globalSequence?: number;
}

// ─── Coherence key extraction ────────────────────────────────────────────────

/**
 * Extracts a causal identity string from a message. Returns null when the
 * relevant field is absent, triggering wall-clock fallback.
 *
 * The `__sequenced?: never` brand prevents byGlobalSequence from being
 * assigned here — that extractor returns SequencedCoherenceKeyExtractor,
 * which forces the stricter config variant at the call site.
 */
export type CoherenceKeyExtractor = ((msg: CausalMetadata) => string | null) & {
  readonly __sequenced?: never;
};

/**
 * Returned by byGlobalSequence. Assigning this as coherenceKey narrows
 * RenderGateConfig to its sequenced variant, making gapStrategy required
 * on all streams at compile time.
 */
export interface SequencedCoherenceKeyExtractor {
  (msg: CausalMetadata): string | null;
  readonly __sequenced: true;
}

/** For event-driven fan-out feeds where the backend stamps a shared correlationId. */
export const byCorrelationId: CoherenceKeyExtractor = (msg) =>
  msg.correlationId ?? null;

/**
 * For exchange-timestamped feeds.
 *
 * Collision risk: independent events at the same millisecond share a key,
 * producing false coherence — the same failure as v0.1.0 wall-clock.
 * Avoid at HFT event rates (multiple events per ms).
 */
export const byEventTimestamp: CoherenceKeyExtractor = (msg) =>
  msg.eventTimestamp != null ? String(msg.eventTimestamp) : null;

/**
 * For sequenced feeds (Solace, AMPS).
 *
 * Backend contract: all messages in a single fan-out batch (e.g. positions
 * and greeks produced by one fill) must share the same sequence ID. A
 * per-message counter means positions and greeks always carry different keys —
 * the gate will never reach causal coherence and every event will emit partial.
 *
 * Returns SequencedCoherenceKeyExtractor, which enforces gapStrategy on all
 * streams at compile time.
 */
export const byGlobalSequence: SequencedCoherenceKeyExtractor = Object.assign(
  (msg: CausalMetadata): string | null =>
    msg.globalSequence != null ? String(msg.globalSequence) : null,
  { __sequenced: true as const },
);

// ─── Stream configuration ────────────────────────────────────────────────────

export interface StreamConfig {
  /**
   * Freshness contract for this stream.
   *
   * false — invalid-if-stale: the gate holds until a message with the current
   *   causal key arrives. Use when stale data is wrong: positions, greeks.
   *
   * true — valid-until-superseded: the last known value is accepted without a
   *   matching causal key. Use when stale data is still correct: prices.
   */
  passThrough: boolean;

  /**
   * Policy for missing sequence numbers. Only active with byGlobalSequence.
   * Required in SequencedStreamConfig; optional (inactive) otherwise.
   *
   * 'wait'           — hold and emit partial on timeout. Use for positions:
   *                    a missing sequence may be an undelivered fill.
   * 'snapshot-fetch' — same as wait, plus fires onGap so the orchestrator
   *                    can request the missing data. Use for greeks.
   * 'partial'        — advance past the gap without flagging isPartial.
   *                    Use for prices: the next tick supersedes the missed one.
   */
  gapStrategy?: "wait" | "snapshot-fetch" | "partial";
}

/**
 * Used when coherenceKey is byGlobalSequence. gapStrategy is required on
 * every stream — each has different semantics for what a missing sequence means.
 */
export interface SequencedStreamConfig extends StreamConfig {
  gapStrategy: "wait" | "snapshot-fetch" | "partial";
}

// ─── Branded domain primitives ───────────────────────────────────────────────
//
// Nominal types over primitives. TypeScript structurally equates number fields,
// so without brands `delta` and `bid` are interchangeable — a silent logic error.
// Cast once at ingestion boundaries (WebSocket parse, test factories) with
// `value as Price`. Never cast inside the gate.

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Bid, ask, mid, or average cost in quote currency. */
export type Price = Brand<number, "Price">;

/** Signed position size. Positive = long, negative = short. */
export type Quantity = Brand<number, "Quantity">;

/** Milliseconds UTC. Exchange time or wall-clock — see context. */
export type Timestamp = Brand<number, "Timestamp">;

/** ISO 4217 currency code, e.g. "USD", "EUR". */
export type CurrencyCode = Brand<string, "CurrencyCode">;

/** d(option price) / d(underlying price). Range: [-1, 1]. */
export type Delta = Brand<number, "Delta">;

/** d(delta) / d(underlying price). Always positive. */
export type Gamma = Brand<number, "Gamma">;

/** d(option price) / d(1pt implied vol). Always positive for long options. */
export type Vega = Brand<number, "Vega">;

/** d(option price) / d(1 calendar day). Typically negative for long options. */
export type Theta = Brand<number, "Theta">;

// ─── Wire types ──────────────────────────────────────────────────────────────

export interface PriceTick extends CausalMetadata {
  instrumentId: InstrumentId;
  bid: Price;
  ask: Price;
  mid: Price;
  timestamp: Timestamp;
}

export interface PositionUpdate extends CausalMetadata {
  instrumentId: InstrumentId;
  quantity: Quantity;
  avgCost: Price;
  currency: CurrencyCode;
  timestamp: Timestamp;
}

export interface GreeksUpdate extends CausalMetadata {
  instrumentId: InstrumentId;
  delta: Delta;
  gamma: Gamma;
  vega: Vega;
  theta: Theta;
  timestamp: Timestamp;
}

// ─── Render gate output ──────────────────────────────────────────────────────

/**
 * Prices, positions, and Greeks verified to originate from the same market
 * event, resolved per instrument. Safe to use for display and tradeable
 * actions when:
 *   - coherentInstruments.has(id) is true for the instruments being used, AND
 *   - isPartial is false (no hold timer fired this cycle).
 *
 * v0.1.0: coherence approximated by wall-clock arrival proximity (50ms window).
 * v0.2.0: coherence verified by causal identity, stream-level.
 * v0.3.0: coherence verified by causal identity, per-instrument.
 */
export interface CoherentSnapshot {
  prices: Record<InstrumentId, PriceTick>;
  positions: Record<InstrumentId, PositionUpdate>;
  greeks: Record<InstrumentId, GreeksUpdate>;
  sequenceId: number;
  /** Wall-clock time of emission (ms UTC). */
  renderedAt: number;

  /**
   * Set of instruments for which all required streams carried the same
   * causal key at emit time. An instrument is coherent when its position
   * and greeks share the same correlationId (or equivalent causal key).
   *
   * Instruments absent from this set either:
   *   - have not yet received data on all required streams (normal at startup), or
   *   - are waiting for a non-passThrough stream to deliver a matching key.
   *
   * Use this for per-row staleness indicators in blotters. For cross-currency
   * P&L aggregation, only include instruments present in this set.
   *
   * Note: the wall-clock fallback path does not populate this set — it emits
   * all instruments as if coherent (same v0.1.0 behaviour). Per-instrument
   * wall-clock tracking is a v0.4.0 concern.
   */
  coherentInstruments: ReadonlySet<InstrumentId>;

  /**
   * True when a hold timer fired for ≥1 instrument during this emit cycle.
   *
   * Precise semantics: at least one instrument's causal key was never matched
   * on all non-passThrough streams within holdTimeout ms. The gate emitted
   * rather than blocking the UI indefinitely.
   *
   * This is distinct from "some instruments haven't arrived yet" (normal at
   * startup). isPartial specifically means "the gate gave up waiting" — a
   * signal that the causal guarantee was sacrificed for liveness on ≥1
   * instrument this cycle.
   *
   * Consumer contract:
   *   isPartial = false, instrument in coherentInstruments  → safe for display
   *     and tradeable actions.
   *   isPartial = false, instrument NOT in coherentInstruments → still loading
   *     or waiting for causal key match; treat as pending.
   *   isPartial = true → ≥1 instrument's coherence was abandoned this cycle;
   *     show staleness indicator; suppress P&L aggregation.
   */
  isPartial: boolean;
}

// ─── Render priority (Render Budget Matrix) ──────────────────────────────────

/**
 *               Off-screen  │  In viewport
 * ─────────────────────────────────────────
 * Active           low      │    high
 * Passive          drop     │    medium
 */
export type RenderPriority = "high" | "medium" | "low" | "drop";

// ─── Worker message bus ──────────────────────────────────────────────────────

export type WorkerInbound =
  | { type: "subscribe"; instrumentIds: InstrumentId[] }
  | { type: "unsubscribe"; instrumentIds: InstrumentId[] }
  | { type: "set-viewport"; instrumentIds: InstrumentId[] }
  | { type: "set-active"; instrumentId: InstrumentId; active: boolean };

export type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

export type WorkerOutbound =
  | { type: "snapshot"; payload: CoherentSnapshot }
  | { type: "connection-status"; status: ConnectionStatus };

// ─── Internal pipeline state ─────────────────────────────────────────────────

export interface StreamState {
  prices: Record<InstrumentId, PriceTick>;
  positions: Record<InstrumentId, PositionUpdate>;
  greeks: Record<InstrumentId, GreeksUpdate>;

  /** Wall-clock arrival time per stream — used by the wall-clock fallback path. */
  lastUpdated: Record<StreamId, number>;

  /**
   * Most recent causal key per stream per instrument.
   *
   * v0.2.0: Record<StreamId, string | null>                — one key per stream globally
   * v0.3.0: Record<StreamId, Record<InstrumentId, string>> — per instrument
   *
   * A key is stored only after a non-null extraction. Absence means the
   * instrument has never delivered a causal key on this stream.
   */
  lastCausalId: Record<StreamId, Record<InstrumentId, string>>;

  /**
   * Most recent globalSequence per stream per instrument.
   *
   * v0.2.0: Record<StreamId, number>                       — one counter per stream globally
   * v0.3.0: Record<StreamId, Record<InstrumentId, number>> — per instrument
   *
   * Gap detection operates per-instrument: AAPL jumping seq 1→3 does not
   * create a false gap for GOOG at seq 5→6.
   */
  lastSequence: Record<StreamId, Record<InstrumentId, number>>;
}

// ─── Gap detection ───────────────────────────────────────────────────────────

export interface GapEvent {
  stream: StreamId;
  /** Which instrument experienced the sequence gap. */
  instrumentId: InstrumentId;
  expectedSeq: number;
  receivedSeq: number;
}

// ─── Exhaustiveness utilities ─────────────────────────────────────────────────

/**
 * Call in the `default` arm of a switch over a discriminated union.
 * TypeScript errors at compile time if any variant is unhandled.
 * Throws at runtime so unhandled variants surface immediately.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}
