// `CoherentDerivationStrategy` — the substrate's single state machine.
//
// On each `setInputs` call the strategy compares refs to decide which input
// kind changed and applies the appropriate policy:
//
//   • Intent change during in-flight → abort + restart against the new pair.
//   • Streaming-only change during in-flight → conflate into `pendingTask`;
//     in-flight completes against its tagged snapshot, then pending kicks off.
//   • No in-flight → start compute immediately.
//
// Cancellation correctness depends on `currentSnapshotId`: late-arriving
// results from aborted computes are dropped in `onResponse` because the id
// has been replaced or cleared.
//
// See `types.ts` JSDoc for the substrate's invariant and the input-kind
// distinction at the public-API level.

import { assertNever } from "../assert-never.js";
import { deserializeError } from "../serialize-error.js";
import { type SnapshotId, SnapshotIssuer } from "../snapshot-id.js";
import { WorkerBridge, type WorkerLike } from "../worker-bridge.js";
import type { WorkerOutbound } from "../worker-protocol.js";
import { makeInitialState, type StrategyState } from "./strategy-state.js";

interface PendingTask<TStreaming, TIntent> {
  readonly streaming: TStreaming;
  readonly intent: TIntent;
  readonly source: string | undefined;
}

export class CoherentDerivationStrategy<TStreaming, TIntent, TOutput> {
  private state: StrategyState<TOutput> = makeInitialState<TOutput>();
  private readonly bridge: WorkerBridge;
  private readonly issuer: SnapshotIssuer;
  private currentSnapshotId: SnapshotId | undefined;
  private pendingTask: PendingTask<TStreaming, TIntent> | undefined;
  // Reference identities of the most recently-observed inputs. Compared by
  // identity (===) on the next `setInputs` to decide intent-change vs.
  // streaming-only-change. `firstCall` distinguishes "haven't seen any
  // inputs yet" from "intent happens to be identical-by-reference to its
  // previous value (which was `undefined`)".
  private lastStreamingRef: TStreaming | undefined;
  private lastIntentRef: TIntent | undefined;
  private firstCall = true;
  // Set true after a `worker-error` is received: the worker process is dead,
  // so further `setInputs` is a no-op and the strategy is terminal until
  // `destroy()` and a fresh remount.
  private workerDead = false;
  // Set true on `destroy()` so subsequent calls become no-ops rather than
  // mutating dangling state.
  private destroyed = false;
  private readonly listeners = new Set<() => void>();

  constructor(worker: WorkerLike, snapshotPrefix: string = "snap") {
    this.issuer = new SnapshotIssuer(snapshotPrefix);
    this.bridge = new WorkerBridge(worker, (msg) => this.onResponse(msg));
  }

  getState(): StrategyState<TOutput> {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setInputs(
    streaming: TStreaming,
    intent: TIntent,
    source: string | undefined,
  ): void {
    if (this.destroyed || this.workerDead) return;

    const intentChanged = this.firstCall || intent !== this.lastIntentRef;
    const streamingChanged =
      this.firstCall || streaming !== this.lastStreamingRef;

    if (!intentChanged && !streamingChanged) return;

    this.firstCall = false;
    this.lastStreamingRef = streaming;
    this.lastIntentRef = intent;

    // Intent change during in-flight: cancel + restart against the new pair.
    if (
      intentChanged &&
      this.state.isComputing &&
      this.currentSnapshotId !== undefined
    ) {
      this.bridge.send({ type: "abort", id: this.currentSnapshotId });
      // Discard any pending streaming-only update — it would have been
      // queued against an intent that's now superseded.
      this.pendingTask = undefined;
      this.startCompute(streaming, intent, source);
      return;
    }

    // Streaming-only change during in-flight: conflate into pendingTask.
    if (this.state.isComputing) {
      this.pendingTask = { streaming, intent, source };
      return;
    }

    // No in-flight: start compute immediately.
    this.startCompute(streaming, intent, source);
  }

  cancel(): void {
    if (this.destroyed) return;
    if (!this.state.isComputing || this.currentSnapshotId === undefined) {
      return;
    }
    this.bridge.send({ type: "abort", id: this.currentSnapshotId });
    this.currentSnapshotId = undefined;
    this.pendingTask = undefined;
    this.commit({
      ...this.state,
      isComputing: false,
      computingSnapshotId: undefined,
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.bridge.terminate();
    this.listeners.clear();
    this.pendingTask = undefined;
    this.currentSnapshotId = undefined;
  }

  private startCompute(
    streaming: TStreaming,
    intent: TIntent,
    source: string | undefined,
  ): void {
    const id = this.issuer.next();
    this.currentSnapshotId = id;
    this.commit({
      data: this.state.data,
      dataSnapshotId: this.state.dataSnapshotId,
      computingSnapshotId: id,
      isComputing: true,
      error: undefined,
    });
    // Omit `source` from the inbound when undefined (bundled-worker pattern).
    // Keeps the wire shape minimal and matches the protocol's optional field.
    this.bridge.send(
      source === undefined
        ? { type: "compute", id, inputs: { streaming, intent } }
        : { type: "compute", id, inputs: { streaming, intent }, source },
    );
  }

  private onResponse(message: WorkerOutbound): void {
    if (message.type === "worker-error") {
      // Worker process is dead. Fail the in-flight (if any), drop pending,
      // mark terminal — subsequent `setInputs` no-ops until destroy().
      this.workerDead = true;
      this.pendingTask = undefined;
      this.currentSnapshotId = undefined;
      this.commit({
        data: this.state.data,
        dataSnapshotId: this.state.dataSnapshotId,
        computingSnapshotId: undefined,
        isComputing: false,
        error: deserializeError(message.error),
      });
      return;
    }

    // Stale: a response for an id that has been superseded (cancellation
    // race, or intent-driven cancel-restart). Drop silently.
    if (message.id !== this.currentSnapshotId) {
      return;
    }
    this.currentSnapshotId = undefined;

    switch (message.type) {
      case "result":
        this.commit({
          data: message.output as TOutput,
          dataSnapshotId: message.id,
          computingSnapshotId: undefined,
          isComputing: false,
          error: undefined,
        });
        break;
      case "error":
        // Preserve last good `data` and `dataSnapshotId`; surface the
        // error so the consumer can render an error UI without losing context.
        this.commit({
          data: this.state.data,
          dataSnapshotId: this.state.dataSnapshotId,
          computingSnapshotId: undefined,
          isComputing: false,
          error: deserializeError(message.error),
        });
        break;
      default:
        // `worker-error` already returned above; any future fourth variant
        // of `WorkerOutbound` will compile-fail here, forcing the strategy
        // to be updated alongside the protocol.
        assertNever(message);
    }

    // Kick off pending task if one was queued during the now-completed
    // compute (a streaming-only change during in-flight).
    if (this.pendingTask !== undefined) {
      const next = this.pendingTask;
      this.pendingTask = undefined;
      this.startCompute(next.streaming, next.intent, next.source);
    }
  }

  private commit(next: StrategyState<TOutput>): void {
    if (next === this.state) return;
    this.state = next;
    // Iterate a snapshot so a listener that unsubscribes itself or another
    // listener mid-notification doesn't perturb this delivery: unsubscribed
    // listeners still fire if they were in the snapshot, and new listeners
    // start receiving on the next commit.
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
