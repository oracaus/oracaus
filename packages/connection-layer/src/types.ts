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
 * All fields are optional. v0.5.0 retains this shape on inbound messages so
 * future middle-tier integration can carry the metadata; v0.5.0 itself does
 * not consume it (cross-stream causal alignment is the middle tier's job per
 * the pivot article).
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
   * Enables gap detection when a sequenced feed (e.g. Solace, AMPS) is wired.
   */
  globalSequence?: number;
}

// ─── Branded domain primitives ───────────────────────────────────────────────
//
// Nominal types over primitives. TypeScript structurally equates number fields,
// so without brands `delta` and `bid` are interchangeable — a silent logic error.
// Cast once at ingestion boundaries (WebSocket parse, test factories) with
// `value as Price`. Never cast inside compute pipelines.

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

// ─── Render priority (used by BackpressureValve) ─────────────────────────────

/**
 *               Off-screen  │  In viewport
 * ─────────────────────────────────────────
 * Active           low      │    high
 * Passive          drop     │    medium
 */
export type RenderPriority = "high" | "medium" | "low" | "drop";

// ─── Worker message bus ──────────────────────────────────────────────────────

/**
 * Tab → SharedWorker control messages. Tabs send these via `MessagePort` to
 * adjust subscriptions and viewport state without affecting other tabs.
 */
export type WorkerInbound =
  | { type: "subscribe"; instrumentIds: InstrumentId[] }
  | { type: "unsubscribe"; instrumentIds: InstrumentId[] }
  | { type: "set-viewport"; instrumentIds: InstrumentId[] }
  | { type: "set-active"; instrumentId: InstrumentId; active: boolean };

/** Connection state of the worker's WebSocket, surfaced to all tabs. */
export type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

/**
 * SharedWorker → Tab broadcast messages. Per-stream typed payloads — no
 * cross-stream fan-in coherence; consumers compose streams as they see fit
 * (or via their own dep-graph).
 *
 * `prices` is batched (post-BackpressureValve flush) because the valve
 * conflates many ticks per instrument down to one before broadcasting.
 * `position` and `greeks` pass through one message at a time — sender's
 * cadence governs.
 */
export type WorkerOutbound =
  | { type: "prices"; payload: readonly PriceTick[] }
  | { type: "position"; payload: PositionUpdate }
  | { type: "greeks"; payload: GreeksUpdate }
  | { type: "connection-status"; status: ConnectionStatus };

// ─── Exhaustiveness utilities ─────────────────────────────────────────────────

/**
 * Call in the `default` arm of a switch over a discriminated union.
 * TypeScript errors at compile time if any variant is unhandled.
 * Throws at runtime so unhandled variants surface immediately.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}
