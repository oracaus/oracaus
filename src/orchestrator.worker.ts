/// <reference lib="webworker" />

/**
 * orchestrator.worker.ts — runs as a SharedWorker
 *
 * One instance per origin, shared across all open tabs.
 * This is the Orchestrator node from the Master Client-Side Blueprint:
 *
 *  Raw WebSocket → BackpressureValve → RenderGate → [this] → BroadcastChannel → Tabs
 *
 * Why SharedWorker?
 *  - Single WebSocket connection regardless of how many tabs are open
 *  - Eliminates per-tab bandwidth multiplication
 *  - Cross-tab state is authoritative and consistent by design
 *  - Centralised P&L math via Web Workers (offloaded from main thread)
 *
 * TypeScript: add "lib": ["webworker"] to tsconfig for SharedWorkerGlobalScope.
 */

import type {
  WorkerInbound,
  WorkerOutbound,
  PriceTick,
  PositionUpdate,
  GreeksUpdate,
} from "./types";
import { BackpressureValve } from "./backpressure-valve";
import { RenderGate } from "./render-gate";

declare const self: SharedWorkerGlobalScope;

// ─── Constants ────────────────────────────────────────────────────────────────

const BROADCAST_CHANNEL_NAME = "trading-orchestrator";
const WS_URL =
  (self as unknown as { WS_URL?: string }).WS_URL ??
  "wss://your-feed.example.com/stream"; // inject via worker options or env

// ─── Shared infrastructure ────────────────────────────────────────────────────

/** All connected tab MessagePorts — used for direct port messages if needed. */
const ports = new Set<MessagePort>();

/** Fanout channel — all tabs subscribe to this for snapshots. */
const broadcast = new BroadcastChannel(BROADCAST_CHANNEL_NAME);

// ─── Pipeline ─────────────────────────────────────────────────────────────────

const renderGate = new RenderGate((snapshot) => {
  broadcast.postMessage({
    type: "snapshot",
    payload: snapshot,
  } satisfies WorkerOutbound);
});

const valve = new BackpressureValve((ticks) => {
  renderGate.updatePrices(ticks);
});

// ─── WebSocket — single connection shared across all tabs ─────────────────────

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1_000;
const MAX_RECONNECT_DELAY = 30_000;

function connect(): void {
  if (ws && ws.readyState < WebSocket.CLOSING) return;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    reconnectDelay = 1_000;
    notify({ type: "connection-status", status: "connected" });
  };

  ws.onmessage = ({ data }) => {
    try {
      route(JSON.parse(data as string));
    } catch {
      // malformed message — ignore
    }
  };

  ws.onclose = () => {
    notify({ type: "connection-status", status: "reconnecting" });
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      connect();
    }, reconnectDelay);
  };

  ws.onerror = () => ws?.close();
}

/**
 * Route inbound WebSocket messages to the appropriate pipeline stage.
 * Adapt this to your actual wire protocol.
 *
 * Expected shape: { stream: 'prices' | 'positions' | 'greeks', payload: {...} }
 */
function route(msg: { stream: string; payload: unknown }): void {
  switch (msg.stream) {
    case "prices":
      valve.ingest(msg.payload as PriceTick);
      break;
    case "positions":
      renderGate.updatePositions(msg.payload as PositionUpdate);
      break;
    case "greeks":
      renderGate.updateGreeks(msg.payload as GreeksUpdate);
      break;
    default:
    // unknown stream — extend here for news, reference data, etc.
  }
}

// ─── Tab connection handling ──────────────────────────────────────────────────

self.onconnect = ({ ports: [port] }) => {
  ports.add(port);

  port.onmessage = ({ data }: MessageEvent<WorkerInbound>) => {
    handleTabMessage(data);
  };

  port.onmessageerror = () => ports.delete(port);

  // Port close isn't surfaced as an event — rely on onmessageerror cleanup
  port.start();
};

function handleTabMessage(msg: WorkerInbound): void {
  switch (msg.type) {
    case "subscribe":
      valve.addWatched(msg.instrumentIds);
      sendSubscription(msg.instrumentIds);
      break;
    case "unsubscribe":
      valve.removeWatched(msg.instrumentIds);
      sendUnsubscription(msg.instrumentIds);
      break;
    case "set-viewport":
      valve.setViewport(msg.instrumentIds);
      break;
    case "set-active":
      valve.setActive(msg.instrumentId, msg.active);
      break;
  }
}

// ─── Server subscription protocol ────────────────────────────────────────────

/** Adapt to your server's subscription protocol. */
function sendSubscription(instrumentIds: string[]): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "subscribe", instrumentIds }));
  }
}

function sendUnsubscription(instrumentIds: string[]): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "unsubscribe", instrumentIds }));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function notify(msg: WorkerOutbound): void {
  broadcast.postMessage(msg);
}

// ─── Initialise ───────────────────────────────────────────────────────────────

connect();
