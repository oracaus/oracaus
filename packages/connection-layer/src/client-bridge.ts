import {
  assertNever,
  type ConnectionStatus,
  type GreeksUpdate,
  type InstrumentId,
  type PositionUpdate,
  type PriceTick,
  type WorkerInbound,
  type WorkerOutbound,
} from "./types.js";

const BROADCAST_CHANNEL_NAME = "oracaus-orchestrator";

type PricesHandler = (ticks: readonly PriceTick[]) => void;
type PositionHandler = (update: PositionUpdate) => void;
type GreeksHandler = (update: GreeksUpdate) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type UnsubscribeFn = () => void;

/**
 * ClientBridge — the tab-side interface to the SharedWorker orchestrator.
 *
 * Each tab instantiates one bridge. The underlying SharedWorker (and its
 * single WebSocket connection) is shared across all tabs in the session.
 *
 * Multi-tab topology:
 *
 *  ┌──────┐   ┌──────┐    ┌──────┐
 *  │ Tab1 │   │ Tab2 │    │ Tab3 │
 *  └──┬───┘   └──┬───┘    └───┬──┘
 *     │ BroadcastChannel ◄────┘
 *     ▼
 *  SharedWorker (single source of truth across tabs)
 *     ▼
 *  WebSocket
 *
 * Per-stream messages flow through. Cross-stream alignment is the consumer's
 * responsibility — typically via a dep-graph (`useMemo`, signals) or via
 * `@oracaus/coherent-derivation` for heavy local compute.
 */
export class ClientBridge {
  private worker: SharedWorker;
  private port: MessagePort;
  private channel: BroadcastChannel;

  private pricesHandlers = new Set<PricesHandler>();
  private positionHandlers = new Set<PositionHandler>();
  private greeksHandlers = new Set<GreeksHandler>();
  private statusHandlers = new Set<StatusHandler>();

  constructor() {
    this.worker = new SharedWorker(
      new URL("./orchestrator.worker.js", import.meta.url),
      { type: "module", name: "oracaus-orchestrator" },
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
   * Signal which instruments are currently visible in the viewport.
   * The BackpressureValve uses this to classify render priority.
   * Call on scroll, resize, or virtualisation viewport changes.
   */
  setViewport(instrumentIds: InstrumentId[]): void {
    this.send({ type: "set-viewport", instrumentIds });
  }

  /**
   * Signal which instrument the user is actively interacting with
   * (e.g. hovering a row, editing a field). Elevates that instrument's
   * priority in the valve's render-budget classification.
   */
  setActive(instrumentId: InstrumentId, active: boolean): void {
    this.send({ type: "set-active", instrumentId, active });
  }

  // ── Event listeners ─────────────────────────────────────────────────────────

  /**
   * Register a handler for batched price ticks (post-BackpressureValve flush).
   * Each batch contains the latest tick per instrument since the last flush.
   */
  onPrices(handler: PricesHandler): UnsubscribeFn {
    this.pricesHandlers.add(handler);
    return () => this.pricesHandlers.delete(handler);
  }

  /** Register a handler for individual position updates. */
  onPosition(handler: PositionHandler): UnsubscribeFn {
    this.positionHandlers.add(handler);
    return () => this.positionHandlers.delete(handler);
  }

  /** Register a handler for individual Greeks updates. */
  onGreeks(handler: GreeksHandler): UnsubscribeFn {
    this.greeksHandlers.add(handler);
    return () => this.greeksHandlers.delete(handler);
  }

  /** Register a handler for connection-status changes. */
  onStatus(handler: StatusHandler): UnsubscribeFn {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  destroy(): void {
    this.port.close();
    this.channel.close();
    this.pricesHandlers.clear();
    this.positionHandlers.clear();
    this.greeksHandlers.clear();
    this.statusHandlers.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private send(msg: WorkerInbound): void {
    this.port.postMessage(msg);
  }

  private dispatch(msg: WorkerOutbound): void {
    switch (msg.type) {
      case "prices":
        for (const h of this.pricesHandlers) h(msg.payload);
        break;
      case "position":
        for (const h of this.positionHandlers) h(msg.payload);
        break;
      case "greeks":
        for (const h of this.greeksHandlers) h(msg.payload);
        break;
      case "connection-status":
        for (const h of this.statusHandlers) h(msg.status);
        break;
      default:
        assertNever(msg);
    }
  }
}
