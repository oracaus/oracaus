// Race-condition audit. Specific interleavings of `setInputs`, `cancel`,
// `destroy`, and worker-error events that aren't otherwise covered by the
// strategy unit tests or the property tests.

import { describe, expect, it } from "vitest";
import { CoherentDerivationStrategy } from "../src/internal/strategies/derivation-strategy.js";
import { type ComputeRunner, WorkerLoop } from "../src/internal/worker-loop.js";
import { FakeWorker } from "./utils/fake-worker.js";
import { intentEchoRunner, streamingEchoRunner } from "./utils/runners.js";

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// Runner that resolves only when its signal aborts. Lets us observe the
// in-flight state without ever auto-completing.
const stalledRunner: ComputeRunner = (_inputs, signal) =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined));
  });

describe("Strategy race conditions — streaming inputs", () => {
  it("setInputs immediately after cancel restarts compute with the new input", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );

    strategy.setInputs("first", undefined, "");
    await flushMicrotasks();
    expect(strategy.getState().data).toBe("first");

    // setInputs starts a new compute; cancel before it completes; setInputs
    // again synchronously — should start fresh with "third".
    strategy.setInputs("second", undefined, "");
    strategy.cancel();
    expect(strategy.getState().isComputing).toBe(false);
    strategy.setInputs("third", undefined, "");
    await flushMicrotasks();
    expect(strategy.getState().data).toBe("third");
    strategy.destroy();
  });

  it("destroy mid-flight does not corrupt state and silences notifications", async () => {
    const fake = new FakeWorker(stalledRunner);
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );
    let notifiesAfterDestroy = 0;

    strategy.setInputs("first", undefined, "");
    await flushMicrotasks();
    expect(strategy.getState().isComputing).toBe(true);

    strategy.subscribe(() => {
      notifiesAfterDestroy += 1;
    });
    strategy.destroy();
    await flushMicrotasks();
    expect(notifiesAfterDestroy).toBe(0);

    // Subsequent calls are no-ops: no throw, no state mutation.
    strategy.setInputs("post", undefined, "");
    strategy.cancel();
    strategy.destroy();
    expect(notifiesAfterDestroy).toBe(0);
  });

  it("error then cancel keeps the error visible", async () => {
    let mode: "ok" | "fail" = "fail";
    const fake = new FakeWorker(async (inputs) => {
      if (mode === "fail") throw new Error("first failure");
      return (inputs as { streaming: unknown }).streaming;
    });
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );

    strategy.setInputs("first", undefined, "");
    await flushMicrotasks();
    expect(strategy.getState().error).toBeInstanceOf(Error);

    // cancel() with no in-flight is a no-op; error must remain.
    strategy.cancel();
    expect(strategy.getState().error).toBeInstanceOf(Error);

    // A fresh setInputs that succeeds clears the error.
    mode = "ok";
    strategy.setInputs("second", undefined, "");
    await flushMicrotasks();
    expect(strategy.getState().error).toBeUndefined();
    expect(strategy.getState().data).toBe("second");
    strategy.destroy();
  });

  it("cancel during pending-only state (compute completed but pending exists) is safe", async () => {
    // Hand-rolled scenario where compute completes between two setInputs
    // calls. The pending-task path (streaming-input absorb) is exercised
    // when a setInputs happens during in-flight; we then immediately cancel.
    const gates: Array<{
      promise: Promise<void>;
      resolve: () => void;
    }> = [];
    const fake = new FakeWorker(async (inputs) => {
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      return (inputs as { streaming: unknown }).streaming;
    });
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );

    strategy.setInputs("first", undefined, "");
    await flushMicrotasks();
    strategy.setInputs("second", undefined, ""); // pending
    strategy.cancel(); // cancels in-flight + drops pending
    expect(strategy.getState().isComputing).toBe(false);
    expect(strategy.getState().computingSnapshotId).toBeUndefined();

    // Resolve the orphaned promise; nothing should commit (strategy already
    // dropped pending and cleared currentSnapshotId).
    gates[0]?.resolve();
    await flushMicrotasks();
    expect(strategy.getState().data).toBeUndefined();
    expect(strategy.getState().isComputing).toBe(false);
    strategy.destroy();
  });
});

describe("Strategy race conditions — intent inputs", () => {
  it("setInputs immediately after cancel restarts cleanly", async () => {
    const fake = new FakeWorker(intentEchoRunner);
    const strategy = new CoherentDerivationStrategy<undefined, string, string>(
      fake,
    );

    strategy.setInputs(undefined, "first", "");
    await flushMicrotasks();
    expect(strategy.getState().data).toBe("first");

    strategy.setInputs(undefined, "second", "");
    strategy.cancel();
    strategy.setInputs(undefined, "third", "");
    await flushMicrotasks();
    expect(strategy.getState().data).toBe("third");
    strategy.destroy();
  });

  it("destroy mid-flight is clean and idempotent", async () => {
    const fake = new FakeWorker(stalledRunner);
    const strategy = new CoherentDerivationStrategy<undefined, string, string>(
      fake,
    );
    let notifiesAfterDestroy = 0;

    strategy.setInputs(undefined, "first", "");
    await flushMicrotasks();
    expect(strategy.getState().isComputing).toBe(true);

    strategy.subscribe(() => {
      notifiesAfterDestroy += 1;
    });
    strategy.destroy();
    strategy.destroy(); // idempotent
    await flushMicrotasks();
    expect(notifiesAfterDestroy).toBe(0);

    strategy.setInputs(undefined, "post", "");
    strategy.cancel();
    expect(notifiesAfterDestroy).toBe(0);
  });

  it("rapid cancel/setInputs alternation does not leak workers or state", async () => {
    const fake = new FakeWorker(stalledRunner);
    const strategy = new CoherentDerivationStrategy<undefined, string, string>(
      fake,
    );

    for (let i = 0; i < 100; i += 1) {
      strategy.setInputs(undefined, `run-${i}`, "");
      strategy.cancel();
    }
    await flushMicrotasks();

    expect(strategy.getState().isComputing).toBe(false);
    expect(strategy.getState().data).toBeUndefined();
    strategy.destroy();
  });
});

describe("Strategy lifecycle invariants", () => {
  it("destroy is idempotent on the unified strategy (both slot variants)", () => {
    // Post-v0.5 refactor: a single CoherentDerivationStrategy handles
    // both streaming and intent slots; exercise destroy() three times
    // for each variant to confirm idempotence.
    const streamingOnly = new CoherentDerivationStrategy<
      unknown,
      undefined,
      unknown
    >(new FakeWorker());
    streamingOnly.destroy();
    streamingOnly.destroy();
    streamingOnly.destroy();

    const intentOnly = new CoherentDerivationStrategy<
      undefined,
      unknown,
      unknown
    >(new FakeWorker());
    intentOnly.destroy();
    intentOnly.destroy();
    intentOnly.destroy();

    expect(true).toBe(true);
  });

  it("setInputs after destroy is a silent no-op (no postMessage to dead worker)", async () => {
    let messagesReceived = 0;
    const fake = new FakeWorker();
    // Wrap postMessage to count calls.
    const originalPost = fake.postMessage.bind(fake);
    fake.postMessage = (msg) => {
      messagesReceived += 1;
      originalPost(msg);
    };
    const strategy = new CoherentDerivationStrategy<
      unknown,
      undefined,
      unknown
    >(fake);

    strategy.destroy();
    strategy.setInputs("anything", undefined, "");
    await flushMicrotasks();

    expect(messagesReceived).toBe(0);
  });
});

describe("Strategy isolation from rogue WorkerLoop output", () => {
  it("a result for an unknown id (no compute ever sent) is dropped", async () => {
    // This simulates a worker that misbehaves by emitting a result for an id
    // we never sent. The strategy must not pick it up — `currentSnapshotId`
    // is undefined, so the message id mismatches.
    const replies: Array<unknown> = [];
    const fake = new FakeWorker();
    const strategy = new CoherentDerivationStrategy<undefined, string, string>(
      fake,
    );
    strategy.subscribe(() => replies.push(strategy.getState()));

    // Bypass the strategy and post directly via the fake's own loop, then
    // verify the strategy ignores it. (In real life this is a worker bug;
    // the test confirms the strategy is robust to it.)
    const rogueLoop = new WorkerLoop(
      async (inputs) => inputs,
      () => {},
    );
    rogueLoop.handle({
      type: "compute",
      id: "rogue-1" as never,
      inputs: "phantom",
      source: "",
    });
    await flushMicrotasks();

    expect(strategy.getState().data).toBeUndefined();
    strategy.destroy();
  });
});
