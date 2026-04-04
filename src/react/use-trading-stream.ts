import { useEffect, useRef, useState } from "react";
import { ClientBridge } from "../client-bridge";
import type { CoherentSnapshot, InstrumentId } from "../types";

// ─── Singleton bridge ─────────────────────────────────────────────────────────
// One ClientBridge per tab, shared across the entire React tree.
// Created lazily; callers never manage the lifecycle directly.

let singleton: ClientBridge | null = null;
function getBridge(): ClientBridge {
  if (!singleton) singleton = new ClientBridge();
  return singleton;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

export interface UseTradingStreamOptions {
  /** Instruments to subscribe to for live updates. */
  instrumentIds: InstrumentId[];
  /**
   * Instruments currently visible in the viewport.
   * Defaults to all instrumentIds if not provided.
   * Update this on scroll/resize for optimal render budget allocation.
   */
  viewportIds?: InstrumentId[];
}

export interface UseTradingStreamResult {
  /** Latest causally consistent snapshot, or null before first emission. */
  snapshot: CoherentSnapshot | null;
  connectionStatus: ConnectionStatus;
  /**
   * Monotonically increasing. Use as a React key or dependency signal
   * rather than deep-comparing the snapshot object.
   */
  sequenceId: number;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useTradingStream
 *
 * Connects a React component to the coherent snapshot pipeline.
 * Handles subscription lifecycle, viewport signalling, and cleanup.
 *
 * @example
 * function BlotterRow({ instrumentId }: { instrumentId: string }) {
 *   const { snapshot, connectionStatus } = useTradingStream({
 *     instrumentIds: [instrumentId],
 *     viewportIds: isVisible ? [instrumentId] : [],
 *   });
 *
 *   if (!snapshot) return <Skeleton />;
 *   const price = snapshot.prices[instrumentId];
 *   const position = snapshot.positions[instrumentId];
 *   const pnl = price && position
 *     ? (price.mid - position.avgCost) * position.quantity
 *     : null;
 *   // pnl is only computed when both values are from a coherent snapshot.
 *   ...
 * }
 */
export function useTradingStream({
  instrumentIds,
  viewportIds,
}: UseTradingStreamOptions): UseTradingStreamResult {
  const bridge = getBridge();

  const [snapshot, setSnapshot] = useState<CoherentSnapshot | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("disconnected");

  // Stable serialised key — avoids churn when parent re-renders with new array refs
  const prevSubKey = useRef("");
  const prevVpKey = useRef("");

  // ── Subscription lifecycle ──────────────────────────────────────────────────

  useEffect(() => {
    const key = [...instrumentIds].sort().join(",");
    if (key === prevSubKey.current) return;

    const prev = prevSubKey.current ? prevSubKey.current.split(",") : [];

    if (prev.length) bridge.unsubscribe(prev);
    if (instrumentIds.length) bridge.subscribe(instrumentIds);

    prevSubKey.current = key;

    return () => {
      bridge.unsubscribe(instrumentIds);
    };
  }, [instrumentIds]);

  // ── Viewport signalling ─────────────────────────────────────────────────────

  useEffect(() => {
    const ids = viewportIds ?? instrumentIds;
    const key = [...ids].sort().join(",");
    if (key === prevVpKey.current) return;
    prevVpKey.current = key;
    bridge.setViewport(ids);
  }, [viewportIds, instrumentIds]);

  // ── Snapshot + status listeners ─────────────────────────────────────────────

  useEffect(() => {
    const unsubSnap = bridge.onSnapshot(setSnapshot);
    const unsubStatus = bridge.onStatus(setConnectionStatus);
    return () => {
      unsubSnap();
      unsubStatus();
    };
  }, []);

  return {
    snapshot,
    connectionStatus,
    sequenceId: snapshot?.sequenceId ?? 0,
  };
}
