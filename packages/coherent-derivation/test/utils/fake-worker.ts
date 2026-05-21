// Test double for `Worker`. Lets us round-trip through the worker protocol
// without depending on a real `Worker` runtime (vitest's node environment
// does not provide one).
//
// Delivery semantics: responses are dispatched on a future microtask via
// `queueMicrotask` so the timing matches a real `Worker`'s `postMessage`
// (handlers fire after the current task, not synchronously). Tests that need
// to inspect the `AbortSignal` propagated to the worker side pass a custom
// `ComputeRunner` to the constructor.
//
// Test helpers (`fireError`, `fireMessageError`) simulate the worker
// emitting `error` / `messageerror` events so the bridge's worker-error
// pathway can be exercised without crashing a real worker process.

import type { WorkerLike } from "../../src/internal/worker-bridge.js";
import {
  type ComputeRunner,
  defaultEchoRunner,
  WorkerLoop,
} from "../../src/internal/worker-loop.js";
import type {
  WorkerInbound,
  WorkerOutbound,
} from "../../src/internal/worker-protocol.js";

type MessageListener = (event: { data: WorkerOutbound }) => void;
type ErrorListener = (event: {
  message: string;
  error?: unknown;
  filename?: string;
  lineno?: number;
}) => void;
type MessageErrorListener = (event: { data?: unknown }) => void;

export class FakeWorker implements WorkerLike {
  private readonly messageListeners = new Set<MessageListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly messageErrorListeners = new Set<MessageErrorListener>();
  private readonly loop: WorkerLoop;
  private terminated = false;

  constructor(runner: ComputeRunner = defaultEchoRunner) {
    this.loop = new WorkerLoop(runner, (response) => {
      queueMicrotask(() => {
        if (this.terminated) return;
        for (const listener of this.messageListeners) {
          listener({ data: response });
        }
      });
    });
  }

  postMessage(message: WorkerInbound): void {
    if (this.terminated) return;
    this.loop.handle(message);
  }

  addEventListener(type: "message", listener: MessageListener): void;
  addEventListener(type: "error", listener: ErrorListener): void;
  addEventListener(type: "messageerror", listener: MessageErrorListener): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: MessageListener | ErrorListener | MessageErrorListener,
  ): void {
    switch (type) {
      case "message":
        this.messageListeners.add(listener as MessageListener);
        return;
      case "error":
        this.errorListeners.add(listener as ErrorListener);
        return;
      case "messageerror":
        this.messageErrorListeners.add(listener as MessageErrorListener);
        return;
    }
  }

  removeEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "error", listener: ErrorListener): void;
  removeEventListener(
    type: "messageerror",
    listener: MessageErrorListener,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: MessageListener | ErrorListener | MessageErrorListener,
  ): void {
    switch (type) {
      case "message":
        this.messageListeners.delete(listener as MessageListener);
        return;
      case "error":
        this.errorListeners.delete(listener as ErrorListener);
        return;
      case "messageerror":
        this.messageErrorListeners.delete(listener as MessageErrorListener);
        return;
    }
  }

  terminate(): void {
    this.terminated = true;
    this.messageListeners.clear();
    this.errorListeners.clear();
    this.messageErrorListeners.clear();
  }

  // ─── Test helpers ────────────────────────────────────────────────────────

  /** Simulate an uncaught error in the worker scope. */
  fireError(message: string, error?: unknown): void {
    if (this.terminated) return;
    queueMicrotask(() => {
      if (this.terminated) return;
      for (const listener of this.errorListeners) {
        listener({ message, error });
      }
    });
  }

  /** Simulate a `messageerror` event (structured-clone failure on receipt). */
  fireMessageError(): void {
    if (this.terminated) return;
    queueMicrotask(() => {
      if (this.terminated) return;
      for (const listener of this.messageErrorListeners) {
        listener({ data: undefined });
      }
    });
  }
}
