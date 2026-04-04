import type {
  WorkerInbound,
  WorkerOutbound,
  CoherentSnapshot,
  InstrumentId,
} from "./types";

const BROADCAST_CHANNEL_NAME = "trading-orchestrator";

type SnapshotHandler = (snapshot: CoherentSnapshot) => void;
type StatusHandler = (
  status: "connected" | "disconnected" | "reconnecting",
) => void;
type UnsubscribeFn = () => void;

/**
 * ClientBridge
 *
 * The tab-side interface to the SharedWorker orchestrator.
 * Each tab instantiates one bridge. The underlying SharedWorker
 * (and its single WebSocket connection) is shared across all tabs.
 *
 * Multi-tab topology — Coordinated: Primary Workflow
 *
 *  ┌──────┐   ┌──────┐    ┌──────┐
 *  │ Tab1 │   │ Tab2 │    │ Tab3 │   ← all show P&L: $10k
 *  └──┬───┘   └──┬───┘    └───┬──┘
 *     │ BroadcastChannel ◄────┘
 *     ▼
 *  SharedWorker (Client-Side Source of Truth)
 *     ▼
 *  WebSocket
 *
 * This eliminates the "Uncoordinated: Diverged Truth" failure mode where
 * Tab1 shows $10k, Tab2 shows $8k (stale), Tab3 shows "Unauthorized".
 */
export class ClientBridge {
  private worker: SharedWorker;
  private port: MessagePort;
  private channel: BroadcastChannel;

  private snapshotHandlers = new Set<SnapshotHandler>();
  private statusHandlers = new Set<StatusHandler>();

  constructor() {
    this.worker = new SharedWorker(
      new URL("./orchestrator.worker.ts", import.meta.url),
      { type: "module", name: "trading-orchestrator" },
    );

    this.port = this.worker.port;
    this.channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);

    this.channel.onmessage = ({ data }: MessageEvent<WorkerOutbound>) => {
      this.dispatch(data);
    };

    this.port.start();
  }

  // ── Subscription API ────────────────────────────────────────────────────────

  subscribe(instrumentIds: InstrumentId[]): void {
    this.send({ type: "subscribe", instrumentIds });
  }

  unsubscribe(instrumentIds: InstrumentId[]): void {
    this.send({ type: "unsubscribe", instrumentIds });
  }

  /**
   * Signal which instruments are currently visible in the browser viewport.
   * The BackpressureValve uses this to classify render priority.
   * Call this whenever the user scrolls or resizes.
   */
  setViewport(instrumentIds: InstrumentId[]): void {
    this.send({ type: "set-viewport", instrumentIds });
  }

  /**
   * Signal which instrument the user is actively interacting with
   * (e.g. hovering a row, editing a field, focusing an order ticket).
   * Elevates that instrument to 'high' priority in the render budget.
   */
  setActive(instrumentId: InstrumentId, active: boolean): void {
    this.send({ type: "set-active", instrumentId, active });
  }

  // ── Event listeners ─────────────────────────────────────────────────────────

  onSnapshot(handler: SnapshotHandler): UnsubscribeFn {
    this.snapshotHandlers.add(handler);
    return () => this.snapshotHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): UnsubscribeFn {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  destroy(): void {
    this.port.close();
    this.channel.close();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private send(msg: WorkerInbound): void {
    this.port.postMessage(msg);
  }

  private dispatch(msg: WorkerOutbound): void {
    switch (msg.type) {
      case "snapshot":
        this.snapshotHandlers.forEach((h) => h(msg.payload));
        break;
      case "connection-status":
        this.statusHandlers.forEach((h) => h(msg.status));
        break;
    }
  }
}
