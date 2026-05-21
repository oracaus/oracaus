import { describe, expect, it } from "vitest";
import { CoherentDerivationStrategy } from "../src/internal/strategies/derivation-strategy.js";
import { FakeWorker } from "./utils/fake-worker.js";
import { intentEchoRunner } from "./utils/runners.js";

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

describe("CoherentDerivationStrategy — initial state", () => {
  it("starts idle: no data, not computing, no error", () => {
    const strategy = new CoherentDerivationStrategy<
      undefined,
      unknown,
      unknown
    >(new FakeWorker(intentEchoRunner));
    expect(strategy.getState()).toEqual({
      data: undefined,
      dataSnapshotId: undefined,
      computingSnapshotId: undefined,
      isComputing: false,
      error: undefined,
    });
    strategy.destroy();
  });
});

describe("CoherentDerivationStrategy — happy path", () => {
  it("setInputs starts a compute and commits the result", async () => {
    const strategy = new CoherentDerivationStrategy<undefined, number, number>(
      new FakeWorker(intentEchoRunner),
    );

    strategy.setInputs(undefined, 7, "");
    expect(strategy.getState().isComputing).toBe(true);
    const id = strategy.getState().computingSnapshotId;
    expect(id).toBeDefined();

    await flushMicrotasks();

    expect(strategy.getState().data).toBe(7);
    expect(strategy.getState().dataSnapshotId).toBe(id);
    expect(strategy.getState().isComputing).toBe(false);
    expect(strategy.getState().computingSnapshotId).toBeUndefined();
    strategy.destroy();
  });
});

describe("CoherentDerivationStrategy — supersession", () => {
  it("a new setInputs while in-flight cancels and restarts with the new inputs", async () => {
    const gates: Array<{
      promise: Promise<void>;
      resolve: () => void;
    }> = [];
    const fake = new FakeWorker(async (inputs, signal) => {
      const gate = deferred<void>();
      gates.push(gate);
      // Resolve early on abort so the runner exits immediately when the
      // signal fires (matches what a real cooperative compute would do).
      signal.addEventListener("abort", () => gate.resolve());
      await gate.promise;
      return (inputs as { intent: unknown }).intent;
    });
    const strategy = new CoherentDerivationStrategy<undefined, string, string>(
      fake,
    );

    strategy.setInputs(undefined, "first", "");
    await flushMicrotasks();
    expect(strategy.getState().isComputing).toBe(true);
    const firstId = strategy.getState().computingSnapshotId;

    // Supersedes "first": "first" gets aborted; a fresh compute for
    // "second" begins immediately with a new snapshot id.
    strategy.setInputs(undefined, "second", "");
    await flushMicrotasks();
    const secondId = strategy.getState().computingSnapshotId;
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    expect(strategy.getState().isComputing).toBe(true);
    expect(strategy.getState().data).toBeUndefined();

    // Resolve the second compute. (The first was aborted; its result was
    // dropped by the worker.)
    gates[1]?.resolve();
    await flushMicrotasks();
    expect(strategy.getState().data).toBe("second");
    expect(strategy.getState().dataSnapshotId).toBe(secondId);
    expect(strategy.getState().isComputing).toBe(false);
    strategy.destroy();
  });

  it("rapid supersession: only the last input's output ever commits", async () => {
    const gates: Array<{
      promise: Promise<void>;
      resolve: () => void;
    }> = [];
    const fake = new FakeWorker(async (inputs, signal) => {
      const gate = deferred<void>();
      gates.push(gate);
      signal.addEventListener("abort", () => gate.resolve());
      await gate.promise;
      return (inputs as { intent: unknown }).intent;
    });
    const strategy = new CoherentDerivationStrategy<undefined, string, string>(
      fake,
    );

    strategy.setInputs(undefined, "a", "");
    await flushMicrotasks();
    strategy.setInputs(undefined, "b", "");
    await flushMicrotasks();
    strategy.setInputs(undefined, "c", "");
    await flushMicrotasks();
    strategy.setInputs(undefined, "d", "");
    await flushMicrotasks();

    // Only the most recent compute is alive; the earlier ones are aborted.
    expect(gates).toHaveLength(4);
    expect(strategy.getState().data).toBeUndefined();
    expect(strategy.getState().isComputing).toBe(true);

    // Resolve the latest compute.
    gates[3]?.resolve();
    await flushMicrotasks();
    expect(strategy.getState().data).toBe("d");
    expect(strategy.getState().isComputing).toBe(false);
    strategy.destroy();
  });

  it("a stale result for a superseded id is dropped (no commit)", async () => {
    let firstResolver: (() => void) | undefined;
    let callCount = 0;
    const fake = new FakeWorker((inputs) => {
      const value = (inputs as { intent: unknown }).intent;
      return new Promise<unknown>((resolve) => {
        callCount += 1;
        if (callCount === 1) {
          firstResolver = () => resolve(value);
        } else {
          resolve(value);
        }
      });
    });
    const strategy = new CoherentDerivationStrategy<undefined, string, string>(
      fake,
    );

    strategy.setInputs(undefined, "first", "");
    await flushMicrotasks();
    // First compute: hung on firstResolver. Now supersede.
    strategy.setInputs(undefined, "second", "");
    await flushMicrotasks();
    // Second compute committed.
    expect(strategy.getState().data).toBe("second");
    const committedId = strategy.getState().dataSnapshotId;

    // Now the first compute resolves late. It should be dropped (snapshot id
    // mismatch), not commit "first" over the top of "second".
    firstResolver?.();
    await flushMicrotasks();
    expect(strategy.getState().data).toBe("second");
    expect(strategy.getState().dataSnapshotId).toBe(committedId);
    strategy.destroy();
  });
});

describe("CoherentDerivationStrategy — error path", () => {
  it("preserves last-good data and dataSnapshotId on compute error", async () => {
    let mode: "ok" | "fail" = "ok";
    const fake = new FakeWorker(async (inputs) => {
      if (mode === "fail") throw new Error("compute failed");
      return (inputs as { intent: unknown }).intent;
    });
    const strategy = new CoherentDerivationStrategy<undefined, string, string>(
      fake,
    );

    strategy.setInputs(undefined, "good", "");
    await flushMicrotasks();
    const goodId = strategy.getState().dataSnapshotId;
    expect(strategy.getState().data).toBe("good");

    mode = "fail";
    strategy.setInputs(undefined, "bad", "");
    await flushMicrotasks();
    const errorState = strategy.getState();
    expect(errorState.data).toBe("good");
    expect(errorState.dataSnapshotId).toBe(goodId);
    expect(errorState.isComputing).toBe(false);
    expect(errorState.error).toBeInstanceOf(Error);
    expect((errorState.error as Error).message).toBe("compute failed");
    strategy.destroy();
  });
});

describe("CoherentDerivationStrategy — explicit cancel()", () => {
  it("cancel() during in-flight compute clears isComputing", async () => {
    const gate = deferred<void>();
    const fake = new FakeWorker(async (inputs) => {
      await gate.promise;
      return (inputs as { intent: unknown }).intent;
    });
    const strategy = new CoherentDerivationStrategy<undefined, string, string>(
      fake,
    );

    strategy.setInputs(undefined, "first", "");
    await flushMicrotasks();
    expect(strategy.getState().isComputing).toBe(true);

    strategy.cancel();
    expect(strategy.getState().isComputing).toBe(false);
    expect(strategy.getState().computingSnapshotId).toBeUndefined();

    gate.resolve();
    await flushMicrotasks();
    expect(strategy.getState().data).toBeUndefined();
    expect(strategy.getState().isComputing).toBe(false);
    strategy.destroy();
  });

  it("cancel() is a no-op when nothing is in flight", () => {
    const strategy = new CoherentDerivationStrategy<
      undefined,
      unknown,
      unknown
    >(new FakeWorker(intentEchoRunner));
    const before = strategy.getState();
    strategy.cancel();
    expect(strategy.getState()).toEqual(before);
    strategy.destroy();
  });
});

describe("CoherentDerivationStrategy — subscriptions", () => {
  it("notifies subscribers on every commit", async () => {
    const strategy = new CoherentDerivationStrategy<undefined, string, string>(
      new FakeWorker(intentEchoRunner),
    );
    let count = 0;
    const unsubscribe = strategy.subscribe(() => {
      count += 1;
    });

    strategy.setInputs(undefined, "a", "");
    // 1 notification: state → isComputing
    await flushMicrotasks();
    // 1 notification: state → committed result
    expect(count).toBe(2);

    unsubscribe();
    strategy.setInputs(undefined, "b", "");
    await flushMicrotasks();
    expect(count).toBe(2);
    strategy.destroy();
  });
});
