// Worker-level error pathways. A worker that crashes (uncaught error in the
// worker scope) or fails to deserialise a posted message must not leave the
// strategy in a zombie `isComputing: true` state. The bridge subscribes to
// `error` and `messageerror` events; both surface as `worker-error`
// `WorkerOutbound` variants that the strategies treat as terminal.

import { describe, expect, it } from "vitest";
import { SnapshotIssuer } from "../src/internal/snapshot-id.js";
import { CoherentDerivationStrategy } from "../src/internal/strategies/derivation-strategy.js";
import {
  type ComputeRunner,
  productionRunner,
  WorkerLoop,
} from "../src/internal/worker-loop.js";
import type { WorkerOutbound } from "../src/internal/worker-protocol.js";
import { FakeWorker } from "./utils/fake-worker.js";
import { computeRequest } from "./utils/messages.js";
import { streamingEchoRunner } from "./utils/runners.js";

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const stalledRunner: ComputeRunner = (_inputs, signal) =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined));
  });

describe("Worker error event surfaces as terminal strategy state", () => {
  it("flips isComputing → false and exposes the error (streaming inputs)", async () => {
    const fake = new FakeWorker(stalledRunner);
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );

    strategy.setInputs("first", undefined, "");
    await flushMicrotasks();
    expect(strategy.getState().isComputing).toBe(true);

    fake.fireError("worker boom", new Error("RangeError boom"));
    await flushMicrotasks();

    const state = strategy.getState();
    expect(state.isComputing).toBe(false);
    expect(state.computingSnapshotId).toBeUndefined();
    expect(state.error).toBeInstanceOf(Error);
    expect((state.error as Error).message).toBe("worker boom");
    strategy.destroy();
  });

  it("flips isComputing → false and exposes the error (intent inputs)", async () => {
    const fake = new FakeWorker(stalledRunner);
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );

    strategy.setInputs("first", undefined, "");
    await flushMicrotasks();
    expect(strategy.getState().isComputing).toBe(true);

    fake.fireError("worker boom");
    await flushMicrotasks();

    const state = strategy.getState();
    expect(state.isComputing).toBe(false);
    expect(state.error).toBeInstanceOf(Error);
    strategy.destroy();
  });

  it("preserves last-good data through a worker crash", async () => {
    // streamingEchoRunner so `data` is the raw streaming value, not the
    // `{ streaming, intent }` envelope the defaultEchoRunner returns.
    const fake = new FakeWorker(streamingEchoRunner);
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );

    strategy.setInputs("good", undefined, "");
    await flushMicrotasks();
    const goodId = strategy.getState().dataSnapshotId;
    expect(strategy.getState().data).toBe("good");

    fake.fireError("crash after first compute");
    await flushMicrotasks();

    const state = strategy.getState();
    expect(state.data).toBe("good");
    expect(state.dataSnapshotId).toBe(goodId);
    expect(state.error).toBeInstanceOf(Error);
    strategy.destroy();
  });

  it("makes setInputs a no-op once the worker is dead", async () => {
    const fake = new FakeWorker(stalledRunner);
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );

    strategy.setInputs("first", undefined, "");
    await flushMicrotasks();
    fake.fireError("dead");
    await flushMicrotasks();
    expect(strategy.getState().isComputing).toBe(false);

    // Subsequent setInputs must not flip isComputing back on or send to a
    // dead worker (which would throw or silently drop in real life).
    strategy.setInputs("post-crash", undefined, "");
    await flushMicrotasks();
    expect(strategy.getState().isComputing).toBe(false);
    expect(strategy.getState().computingSnapshotId).toBeUndefined();
    strategy.destroy();
  });
});

describe("messageerror event surfaces as worker-error", () => {
  it("structured-clone failure on a posted response surfaces as terminal error", async () => {
    const fake = new FakeWorker(stalledRunner);
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );

    strategy.setInputs("first", undefined, "");
    await flushMicrotasks();

    fake.fireMessageError();
    await flushMicrotasks();

    const state = strategy.getState();
    expect(state.isComputing).toBe(false);
    expect(state.error).toBeInstanceOf(Error);
    expect((state.error as Error).name).toBe("WorkerMessageError");
    strategy.destroy();
  });
});

describe("productionRunner — [native code] detection", () => {
  it("rejects bound-function source with a clear error", async () => {
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(productionRunner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();
    const bound = Math.max.bind(null);

    loop.handle(computeRequest(id, [1, 2, 3], bound.toString()));
    await flushMicrotasks();

    expect(replies).toHaveLength(1);
    const reply = replies[0];
    if (reply?.type !== "error") {
      throw new Error(`expected error response, got ${reply?.type}`);
    }
    expect(reply.error.name).toBe("TypeError");
    expect(reply.error.message).toContain("[native code]");
  });

  it("rejects native-function source with a clear error", async () => {
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(productionRunner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    loop.handle(computeRequest(id, [1, 2, 3], Math.max.toString()));
    await flushMicrotasks();

    const reply = replies[0];
    expect(reply?.type).toBe("error");
    if (reply?.type === "error") {
      expect(reply.error.message).toContain("[native code]");
    }
  });

  it("accepts a plain compute function source", async () => {
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(productionRunner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();
    const compute = (xs: number[]): number => Math.max(...xs);

    loop.handle(computeRequest(id, [3, 1, 4, 1, 5], compute.toString()));
    await flushMicrotasks();

    expect(replies).toEqual([{ type: "result", id, output: 5 }]);
  });
});
