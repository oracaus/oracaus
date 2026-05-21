import { useEffect, useRef, useSyncExternalStore } from "react";
import { ClientBridge } from "../client-bridge.js";
import type {
  ConnectionStatus,
  GreeksUpdate,
  InstrumentId,
  PositionUpdate,
  PriceTick,
} from "../types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UseTradingStreamOptions {
  /** Instruments to subscribe to for live updates. */
  instrumentIds: InstrumentId[];
  /**
   * Instruments currently visible in the viewport. Defaults to `instrumentIds`.
   * Update on scroll/resize for optimal render-budget allocation in the valve.
   */
  viewportIds?: InstrumentId[];
}

export interface UseTradingStreamResult {
  /** Latest price per instrument. Updated as the BackpressureValve flushes. */
  prices: Readonly<Record<InstrumentId, PriceTick>>;
  /** Latest position per instrument. */
  positions: Readonly<Record<InstrumentId, PositionUpdate>>;
  /** Latest Greeks per instrument. */
  greeks: Readonly<Record<InstrumentId, GreeksUpdate>>;
  /** WebSocket connection status. */
  connectionStatus: ConnectionStatus;
}

// ─── External store ───────────────────────────────────────────────────────────
//
// The hook is backed by `useSyncExternalStore`, React's tearing-free primitive
// for subscribing to mutable external state. The store below adapts the
// `ClientBridge`'s per-stream callbacks into a single accumulating snapshot
// that React re-reads on every commit.
//
// Identity discipline: each per-stream update returns a new state object only
// when the underlying field actually changes. `getSnapshot` returns the same
// reference between unchanged commits — required by `useSyncExternalStore` to
// avoid re-render loops.

type Listener = () => void;
type Unsubscribe = () => void;

const INITIAL_STATE: UseTradingStreamResult = Object.freeze({
  prices: Object.freeze({}),
  positions: Object.freeze({}),
  greeks: Object.freeze({}),
  connectionStatus: "disconnected",
});

class TradingStreamStore {
  private state: UseTradingStreamResult = INITIAL_STATE;
  private readonly listeners = new Set<Listener>();
  private readonly bridgeUnsubscribes: Unsubscribe[];

  constructor(public readonly bridge: ClientBridge) {
    this.bridgeUnsubscribes = [
      bridge.onPrices((payload) => this.applyPrices(payload)),
      bridge.onPosition((payload) => this.applyPosition(payload)),
      bridge.onGreeks((payload) => this.applyGreeks(payload)),
      bridge.onStatus((payload) => this.applyStatus(payload)),
    ];
  }

  /** Stable reference for `useSyncExternalStore`. */
  readonly subscribe = (listener: Listener): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable reference for `useSyncExternalStore`. */
  readonly getSnapshot = (): UseTradingStreamResult => this.state;

  /** Stable reference for SSR. Returns the frozen initial state. */
  readonly getServerSnapshot = (): UseTradingStreamResult => INITIAL_STATE;

  destroy(): void {
    for (const unsub of this.bridgeUnsubscribes) unsub();
    this.listeners.clear();
  }

  // ── Stream appliers ────────────────────────────────────────────────────────

  private applyPrices(payload: readonly PriceTick[]): void {
    if (payload.length === 0) return;
    const next: Record<InstrumentId, PriceTick> = { ...this.state.prices };
    for (const tick of payload) next[tick.instrumentId] = tick;
    this.commit({ ...this.state, prices: next });
  }

  private applyPosition(payload: PositionUpdate): void {
    this.commit({
      ...this.state,
      positions: {
        ...this.state.positions,
        [payload.instrumentId]: payload,
      },
    });
  }

  private applyGreeks(payload: GreeksUpdate): void {
    this.commit({
      ...this.state,
      greeks: {
        ...this.state.greeks,
        [payload.instrumentId]: payload,
      },
    });
  }

  private applyStatus(payload: ConnectionStatus): void {
    if (this.state.connectionStatus === payload) return;
    this.commit({ ...this.state, connectionStatus: payload });
  }

  private commit(next: UseTradingStreamResult): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

// ─── Singleton bridge + store ─────────────────────────────────────────────────
// One ClientBridge and one TradingStreamStore per tab, shared across the React
// tree. Created lazily on first hook mount; consumers never manage lifecycle.

let bridgeSingleton: ClientBridge | null = null;
let storeSingleton: TradingStreamStore | null = null;

function getStore(): TradingStreamStore {
  if (!storeSingleton) {
    if (!bridgeSingleton) bridgeSingleton = new ClientBridge();
    storeSingleton = new TradingStreamStore(bridgeSingleton);
  }
  return storeSingleton;
}

/** Disposes the tab's store + bridge. Test-only. */
export function destroyTradingStream(): void {
  storeSingleton?.destroy();
  storeSingleton = null;
  bridgeSingleton?.destroy();
  bridgeSingleton = null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useTradingStream
 *
 * React hook for subscribing to the SharedWorker's per-stream output.
 * Backed by `useSyncExternalStore` — tearing-free under React 18+ concurrent
 * renderers. Per-stream state accumulates as messages arrive.
 *
 * Cross-stream alignment is the consumer's job — typically via a dep-graph
 * (`useMemo`, signals) or via `@oracaus/coherent-derivation` for heavy compute.
 *
 * @example
 * function BlotterRow({ instrumentId }: { instrumentId: string }) {
 *   const { prices, positions, connectionStatus } = useTradingStream({
 *     instrumentIds: [instrumentId],
 *   });
 *   const price = prices[instrumentId];
 *   const position = positions[instrumentId];
 *   const pnl = useMemo(
 *     () => price && position
 *       ? (price.mid - position.avgCost) * position.quantity
 *       : null,
 *     [price, position],
 *   );
 *   if (connectionStatus !== "connected") return <Skeleton />;
 *   return <Row price={price} position={position} pnl={pnl} />;
 * }
 */
export function useTradingStream({
  instrumentIds,
  viewportIds,
}: UseTradingStreamOptions): UseTradingStreamResult {
  const store = getStore();

  // Stable serialised keys — avoid effect churn when parents re-render with
  // new array refs but the same logical IDs.
  const prevSubKey = useRef("");
  const prevVpKey = useRef("");

  // ── Subscription lifecycle ──────────────────────────────────────────────────

  useEffect(() => {
    const key = [...instrumentIds].sort().join(",");
    if (key === prevSubKey.current) return;

    const prev = prevSubKey.current ? prevSubKey.current.split(",") : [];
    if (prev.length) store.bridge.unsubscribe(prev);
    if (instrumentIds.length) store.bridge.subscribe(instrumentIds);

    prevSubKey.current = key;

    return () => {
      store.bridge.unsubscribe(instrumentIds);
    };
  }, [instrumentIds, store]);

  // ── Viewport signalling ─────────────────────────────────────────────────────

  useEffect(() => {
    const ids = viewportIds ?? instrumentIds;
    const key = [...ids].sort().join(",");
    if (key === prevVpKey.current) return;
    prevVpKey.current = key;
    store.bridge.setViewport(ids);
  }, [viewportIds, instrumentIds, store]);

  // ── External-store read ─────────────────────────────────────────────────────

  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
}
