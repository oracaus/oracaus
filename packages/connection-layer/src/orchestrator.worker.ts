/// <reference lib="webworker" />

/**
 * orchestrator.worker.ts — runs as a SharedWorker
 *
 * One instance per origin, shared across all open tabs.
 *
 *  Raw WebSocket → BackpressureValve(prices) → BroadcastChannel → Tabs
 *  Raw WebSocket → positions / greeks (pass-through) → BroadcastChannel → Tabs
 *
 * Why SharedWorker:
 *  - Single WebSocket connection per browser session, regardless of tab count
 *  - Eliminates per-tab bandwidth multiplication
 *  - Cross-tab state is authoritative and consistent by design
 *  - BackpressureValve's three-stage filter (active / viewport / 60fps) runs
 *    off the main thread
 *
 * What this worker is NOT (post-v0.5.0 strip):
 *  - Cross-stream causal coherence is the middle tier's job. The pre-v0.5.0
 *    `RenderGate` that composed fan-in streams here is gone — see the pivot
 *    article for rationale. Per-stream messages flow through unchanged.
 *
 * TypeScript: requires "lib": ["webworker"] in the tsconfig.
 */

import { BackpressureValve } from "./backpressure-valve.js";
import {
  assertNever,
  type GreeksUpdate,
  type PositionUpdate,
  type PriceTick,
  type StreamId,
  type WorkerInbound,
  type WorkerOutbound,
} from "./types.js";

declare const self: SharedWorkerGlobalScope;

// ─── Constants ────────────────────────────────────────────────────────────────

const BROADCAST_CHANNEL_NAME = "oracaus-orchestrator";
const WS_URL =
  (self as unknown as { WS_URL?: string }).WS_URL ??
  "wss://your-feed.example.com/stream"; // inject via worker options or env

// ─── Shared infrastructure ────────────────────────────────────────────────────

/** Connected tab MessagePorts — tracked for lifecycle management. Fanout uses BroadcastChannel. */
const ports = new Set<MessagePort>();

/** Fanout channel — all tabs subscribe to this. */
const broadcast = new BroadcastChannel(BROADCAST_CHANNEL_NAME);

/**
 * Prices flow through the valve. The valve's `onFlush` callback receives a
 * conflated `Map<InstrumentId, PriceTick>` at most once per ~16ms; this
 * worker flattens it to an array for the broadcast.
 */
const valve = new BackpressureValve((ticks) => {
  const payload = Array.from(ticks.values());
  if (payload.length > 0) {
    notify({ type: "prices", payload });
  }
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
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectDelay = 1_000;
    notify({ type: "connection-status", status: "connected" });
  };

  ws.onmessage = ({ data }) => {
    try {
      route(JSON.parse(data as string));
    } catch {
      // Malformed message — ignored. A production adopter wires their own
      // error reporting here.
    }
  };

  ws.onclose = () => {
    notify({ type: "connection-status", status: "reconnecting" });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      connect();
    }, reconnectDelay);
  };

  ws.onerror = () => ws?.close();
}

/**
 * Route inbound WebSocket messages to the appropriate output path.
 *
 * Expected wire shape: `{ stream: 'prices' | 'positions' | 'greeks', payload: {...} }`.
 * Adopters with a different wire protocol adapt this function and `KNOWN_STREAMS`.
 *
 * Causal metadata fields (`correlationId`, `eventTimestamp`, `globalSequence`)
 * are preserved on payload objects and flow through unchanged. Cross-stream
 * alignment is the middle tier's responsibility — this worker is a transport.
 */
const KNOWN_STREAMS = new Set<StreamId>(["prices", "positions", "greeks"]);

function isKnownStream(s: string): s is StreamId {
  return KNOWN_STREAMS.has(s as StreamId);
}

function route(msg: { stream: string; payload: unknown }): void {
  if (!isKnownStream(msg.stream)) {
    // Unknown streams ignored. Add to `StreamId` in `types.ts` and to
    // `KNOWN_STREAMS` to enable routing.
    return;
  }

  const stream: StreamId = msg.stream;

  switch (stream) {
    case "prices":
      valve.ingest(msg.payload as PriceTick);
      break;
    case "positions":
      notify({ type: "position", payload: msg.payload as PositionUpdate });
      break;
    case "greeks":
      notify({ type: "greeks", payload: msg.payload as GreeksUpdate });
      break;
    default:
      assertNever(stream);
  }
}

// ─── Tab connection handling ──────────────────────────────────────────────────

self.onconnect = ({ ports: [port] }) => {
  if (!port) return;
  ports.add(port);

  port.onmessage = ({ data }: MessageEvent<WorkerInbound>) => {
    handleTabMessage(data);
  };

  port.onmessageerror = () => ports.delete(port);

  // Port close isn't surfaced as an event — rely on onmessageerror cleanup.
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
    default:
      assertNever(msg);
  }
}

// ─── Server subscription protocol ────────────────────────────────────────────

/** Adapt to the actual server's subscription protocol. */
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
