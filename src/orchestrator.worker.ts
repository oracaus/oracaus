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
 *  - Stream coordination (valve, gate) offloaded from main thread
 *
 * TypeScript: add "lib": ["webworker"] to tsconfig for SharedWorkerGlobalScope.
 */

import { BackpressureValve } from "./backpressure-valve";
import { RenderGate } from "./render-gate";
import type {
  GreeksUpdate,
  PositionUpdate,
  PriceTick,
  StreamId,
  WorkerInbound,
  WorkerOutbound,
} from "./types";
import { assertNever, byCorrelationId } from "./types";

declare const self: SharedWorkerGlobalScope;

// ─── Constants ────────────────────────────────────────────────────────────────

const BROADCAST_CHANNEL_NAME = "trading-orchestrator";
const WS_URL =
  (self as unknown as { WS_URL?: string }).WS_URL ??
  "wss://your-feed.example.com/stream"; // inject via worker options or env

// ─── Shared infrastructure ────────────────────────────────────────────────────

/** All connected tab MessagePorts — tracked for lifecycle management. All fanout uses BroadcastChannel. */
const ports = new Set<MessagePort>();

/** Fanout channel — all tabs subscribe to this for snapshots. */
const broadcast = new BroadcastChannel(BROADCAST_CHANNEL_NAME);

// ─── Pipeline (v0.2.0) ───────────────────────────────────────────────────────────

const renderGate = new RenderGate(
  (snapshot) => {
    broadcast.postMessage({
      type: "snapshot",
      payload: snapshot,
    } satisfies WorkerOutbound);
  },
  {
    // ── Coherence strategy ──────────────────────────────────────────────
    // Swap to byEventTimestamp or byGlobalSequence per your feed protocol.
    // When messages lack the configured field, the gate automatically falls
    // back to wall-clock coherence (v0.1.0 behaviour).
    coherenceKey: byCorrelationId,

    // ── Stream freshness semantics ──────────────────────────────────────
    streams: {
      prices: { passThrough: true }, // valid-until-superseded
      positions: { passThrough: false }, // invalid-if-stale
      greeks: { passThrough: false, gapStrategy: "snapshot-fetch" },
    },

    // ── Hold timeout ────────────────────────────────────────────────────
    // Set to p99 tail latency of your slowest downstream service.
    holdTimeout: 200,
  },
);

// Request snapshot on sequence gaps (globalSequence feeds only).
// The backend endpoint must serve a point-in-time snapshot by sequence range.
renderGate.onGap(({ stream, expectedSeq, receivedSeq }) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        action: "snapshot-request",
        stream,
        fromSeq: expectedSeq,
        toSeq: receivedSeq - 1,
      }),
    );
  }
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
      // malformed message — ignore
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
 * Route inbound WebSocket messages to the appropriate pipeline stage.
 * Adapt this to your actual wire protocol.
 *
 * Expected shape: { stream: 'prices' | 'positions' | 'greeks', payload: {...} }
 *
 * Causal metadata (correlationId, eventTimestamp, globalSequence) is carried
 * on the payload objects and flows through the pipeline automatically.
 */
const KNOWN_STREAMS = new Set<StreamId>(["prices", "positions", "greeks"]);

function isKnownStream(s: string): s is StreamId {
  return KNOWN_STREAMS.has(s as StreamId);
}

function route(msg: { stream: string; payload: unknown }): void {
  // Validate at the wire boundary — JSON.parse returns any, so we cannot
  // trust msg.stream is a StreamId without a runtime check.
  if (!isKnownStream(msg.stream)) {
    // Unknown streams are ignored here (e.g. news, reference data on the same
    // socket). Add to StreamId in types.ts and KNOWN_STREAMS to enable routing.
    return;
  }

  const stream: StreamId = msg.stream;

  switch (stream) {
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
      assertNever(stream);
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
    default:
      assertNever(msg);
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
