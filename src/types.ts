// ─── Domain types ────────────────────────────────────────────────────────────

export type InstrumentId = string;
export type StreamId = "prices" | "positions" | "greeks";

export interface PriceTick {
  instrumentId: InstrumentId;
  bid: number;
  ask: number;
  mid: number;
  timestamp: number;
}

export interface PositionUpdate {
  instrumentId: InstrumentId;
  quantity: number;
  avgCost: number;
  currency: string;
  timestamp: number;
}

export interface GreeksUpdate {
  instrumentId: InstrumentId;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  timestamp: number;
}

// ─── Render Gate ─────────────────────────────────────────────────────────────

/**
 * A snapshot where Price, Position and Greeks are causally consistent —
 * all derived from data that was valid at the same moment in time.
 * Mixing a t+1 price with a t+0 position produces mathematically
 * invalid P&L. This type is the contract that the RenderGate enforces.
 */
export interface CoherentSnapshot {
  prices: Record<InstrumentId, PriceTick>;
  positions: Record<InstrumentId, PositionUpdate>;
  greeks: Record<InstrumentId, GreeksUpdate>;
  sequenceId: number;
  renderedAt: number;
  /** True when the gate timed out waiting for full coherence. */
  isPartial: boolean;
}

// ─── Render priority (Render Budget Matrix) ───────────────────────────────────

/**
 * Classification from the Render Budget Prioritization Matrix:
 *
 *               Off-screen    │    In Viewport
 * ──────────────────────────────────────────────
 * Active        low           │    high
 * Passive       drop          │    medium
 */
export type RenderPriority = "high" | "medium" | "low" | "drop";

// ─── Worker message bus ───────────────────────────────────────────────────────

export type WorkerInbound =
  | { type: "subscribe"; instrumentIds: InstrumentId[] }
  | { type: "unsubscribe"; instrumentIds: InstrumentId[] }
  | { type: "set-viewport"; instrumentIds: InstrumentId[] }
  | { type: "set-active"; instrumentId: InstrumentId; active: boolean };

export type WorkerOutbound =
  | { type: "snapshot"; payload: CoherentSnapshot }
  | {
      type: "connection-status";
      status: "connected" | "disconnected" | "reconnecting";
    };

// ─── Internal pipeline state ──────────────────────────────────────────────────

export interface StreamState {
  prices: Record<InstrumentId, PriceTick>;
  positions: Record<InstrumentId, PositionUpdate>;
  greeks: Record<InstrumentId, GreeksUpdate>;
  lastUpdated: Record<StreamId, number>;
}
