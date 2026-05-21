// Main-thread bridge over a Worker (or a Worker-like for tests). Pure
// transport: send `WorkerInbound`, receive `WorkerOutbound`, terminate cleanly.
// Response correlation to in-flight requests lives in the strategy state
// machine, not here.
//
// Beyond per-compute results, the bridge subscribes to the worker's `error`
// and `messageerror` events. An uncaught error in the worker scope or a
// structured-clone failure on the response is surfaced as a synthetic
// `WorkerCrashResponse` through the same `onMessage` channel — strategies
// discriminate on `type` and handle the new variant as a terminal failure
// without a separate code path.

import type {
  SerializedError,
  WorkerInbound,
  WorkerOutbound,
} from "./worker-protocol.js";

interface WorkerErrorEvent {
  readonly message: string;
  readonly error?: unknown;
  readonly filename?: string;
  readonly lineno?: number;
}

interface WorkerMessageErrorEvent {
  readonly data?: unknown;
}

type MessageListener = (event: { data: WorkerOutbound }) => void;
type ErrorListener = (event: WorkerErrorEvent) => void;
type MessageErrorListener = (event: WorkerMessageErrorEvent) => void;

/**
 * Structural subset of `Worker` consumed by `WorkerBridge`. The real `Worker`
 * class is assignable to this type. Test doubles (`FakeWorker` in
 * `test/utils/`) implement it directly.
 */
export interface WorkerLike {
  postMessage(message: WorkerInbound): void;
  addEventListener(type: "message", listener: MessageListener): void;
  addEventListener(type: "error", listener: ErrorListener): void;
  addEventListener(type: "messageerror", listener: MessageErrorListener): void;
  removeEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "error", listener: ErrorListener): void;
  removeEventListener(
    type: "messageerror",
    listener: MessageErrorListener,
  ): void;
  terminate(): void;
}

export type OutboundHandler = (message: WorkerOutbound) => void;

export class WorkerBridge {
  private readonly worker: WorkerLike;
  private readonly messageListener: MessageListener;
  private readonly errorListener: ErrorListener;
  private readonly messageErrorListener: MessageErrorListener;
  private terminated = false;

  constructor(worker: WorkerLike, onMessage: OutboundHandler) {
    this.worker = worker;
    this.messageListener = (event) => onMessage(event.data);
    this.errorListener = (event) => {
      const error: SerializedError = {
        name: "WorkerError",
        message: event.message,
        ...(event.error instanceof Error && event.error.stack !== undefined
          ? { stack: event.error.stack }
          : {}),
      };
      onMessage({ type: "worker-error", error });
    };
    this.messageErrorListener = (_event) => {
      onMessage({
        type: "worker-error",
        error: {
          name: "WorkerMessageError",
          message:
            "failed to deserialise a message posted by the worker " +
            "(structured-clone failure on the worker → main side)",
        },
      });
    };
    this.worker.addEventListener("message", this.messageListener);
    this.worker.addEventListener("error", this.errorListener);
    this.worker.addEventListener("messageerror", this.messageErrorListener);
  }

  send(message: WorkerInbound): void {
    if (this.terminated) return;
    this.worker.postMessage(message);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.removeEventListener("message", this.messageListener);
    this.worker.removeEventListener("error", this.errorListener);
    this.worker.removeEventListener("messageerror", this.messageErrorListener);
    this.worker.terminate();
  }
}
