import { describe, expect, it } from "vitest";
import { CoherentDerivationStrategy } from "../src/internal/strategies/derivation-strategy.js";
import { FakeWorker } from "./utils/fake-worker.js";
import { streamingEchoRunner } from "./utils/runners.js";

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
      unknown,
      undefined,
      unknown
    >(new FakeWorker(streamingEchoRunner));
    const state = strategy.getState();

    expect(state).toEqual({
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
  it("setInputs starts a compute and commits (data, dataSnapshotId) atomically", async () => {
    const strategy = new CoherentDerivationStrategy<
      { value: number },
      undefined,
      { value: number }
    >(new FakeWorker(streamingEchoRunner));

    strategy.setInputs({ value: 7 }, undefined, "");
    // Synchronously after setInputs, isComputing flips to true.
    expect(strategy.getState().isComputing).toBe(true);
    const snapshotIdAtStart = strategy.getState().computingSnapshotId;
    expect(snapshotIdAtStart).toBeDefined();

    await flushMicrotasks();

    const finalState = strategy.getState();
    expect(finalState.isComputing).toBe(false);
    expect(finalState.computingSnapshotId).toBeUndefined();
    expect(finalState.data).toEqual({ value: 7 });
    expect(finalState.dataSnapshotId).toBe(snapshotIdAtStart);
    expect(finalState.error).toBeUndefined();
    strategy.destroy();
  });

  it("clears error on the next successful compute", async () => {
    let mode: "ok" | "fail" = "fail";
    const fake = new FakeWorker(async (inputs) => {
      if (mode === "fail") throw new Error("nope");
      return (inputs as { streaming: unknown }).streaming;
    });
    const strategy = new CoherentDerivationStrategy<
      unknown,
      undefined,
      unknown
    >(fake);

    strategy.setInputs("first", undefined, "");
    await flushMicrotasks();
    expect(strategy.getState().error).toBeDefined();

    mode = "ok";
    strategy.setInputs("second", undefined, "");
    await flushMicrotasks();
    expect(strategy.getState().error).toBeUndefined();
    expect(strategy.getState().data).toBe("second");
    strategy.destroy();
  });
});

describe("CoherentDerivationStrategy — coherence under streaming inputs", () => {
  it("holds visible state during compute; new inputs buffer until completion", async () => {
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
    expect(strategy.getState().isComputing).toBe(true);
    expect(strategy.getState().data).toBeUndefined();

    // Inputs change while compute is in flight — visible state should NOT
    // flip to "second" mid-flight.
    strategy.setInputs("second", undefined, "");
    expect(strategy.getState().data).toBeUndefined();
    expect(strategy.getState().isComputing).toBe(true);

    // Resolve the first compute only. The second one is buffered as pending
    // and gets its own gate when it starts.
    gates[0]?.resolve();
    await flushMicrotasks();
    // First compute committed; pending "second" started; isComputing back to true.
    expect(strategy.getState().data).toBe("first");
    expect(strategy.getState().isComputing).toBe(true);
    expect(gates).toHaveLength(2);

    gates[1]?.resolve();
    await flushMicrotasks();
    expect(strategy.getState().data).toBe("second");
    expect(strategy.getState().isComputing).toBe(false);
    strategy.destroy();
  });

  it("conflates rapid input changes — only the latest pending survives", async () => {
    let resolves: Array<() => void> = [];
    const fake = new FakeWorker(
      (inputs) =>
        new Promise<unknown>((resolve) => {
          const value = (inputs as { streaming: unknown }).streaming;
          resolves.push(() => resolve(value));
        }),
    );
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );

    strategy.setInputs("first", undefined, "");
    await flushMicrotasks();
    strategy.setInputs("second", undefined, "");
    strategy.setInputs("third", undefined, "");
    strategy.setInputs("fourth", undefined, "");
    // Only "first" in flight; "fourth" is the surviving pending.

    expect(resolves).toHaveLength(1);
    resolves[0]?.();
    resolves = [];
    await flushMicrotasks();
    // "first" committed.
    expect(strategy.getState().data).toBe("first");
    // The next compute is "fourth", not "second" or "third".
    expect(strategy.getState().isComputing).toBe(true);
    expect(resolves).toHaveLength(1);
    resolves[0]?.();
    await flushMicrotasks();
    expect(strategy.getState().data).toBe("fourth");
    expect(strategy.getState().isComputing).toBe(false);
    strategy.destroy();
  });

  it("dataSnapshotId always matches the snapshot the data was computed at", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const strategy = new CoherentDerivationStrategy<number, undefined, number>(
      fake,
    );

    strategy.setInputs(1, undefined, "");
    await flushMicrotasks();
    const id1 = strategy.getState().dataSnapshotId;
    expect(strategy.getState().data).toBe(1);

    strategy.setInputs(2, undefined, "");
    await flushMicrotasks();
    const id2 = strategy.getState().dataSnapshotId;
    expect(strategy.getState().data).toBe(2);
    expect(id2).not.toBe(id1);

    strategy.setInputs(3, undefined, "");
    await flushMicrotasks();
    const id3 = strategy.getState().dataSnapshotId;
    expect(strategy.getState().data).toBe(3);
    expect(id3).not.toBe(id1);
    expect(id3).not.toBe(id2);
    strategy.destroy();
  });
});

describe("CoherentDerivationStrategy — error path", () => {
  it("preserves last-good data and dataSnapshotId on compute error", async () => {
    let mode: "ok" | "fail" = "ok";
    const fake = new FakeWorker(async (inputs) => {
      if (mode === "fail") throw new Error("compute failed");
      return (inputs as { streaming: unknown }).streaming;
    });
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );

    strategy.setInputs("good", undefined, "");
    await flushMicrotasks();
    const goodId = strategy.getState().dataSnapshotId;
    expect(strategy.getState().data).toBe("good");

    mode = "fail";
    strategy.setInputs("bad", undefined, "");
    await flushMicrotasks();
    const errorState = strategy.getState();
    expect(errorState.data).toBe("good"); // last-good preserved
    expect(errorState.dataSnapshotId).toBe(goodId);
    expect(errorState.isComputing).toBe(false);
    expect(errorState.error).toBeInstanceOf(Error);
    expect((errorState.error as Error).message).toBe("compute failed");
    strategy.destroy();
  });
});

describe("CoherentDerivationStrategy — cancellation", () => {
  it("cancel() during in-flight compute clears isComputing and drops pending", async () => {
    const gate = deferred<void>();
    const fake = new FakeWorker(async (inputs) => {
      await gate.promise;
      return (inputs as { streaming: unknown }).streaming;
    });
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      fake,
    );

    strategy.setInputs("first", undefined, "");
    await flushMicrotasks();
    strategy.setInputs("second", undefined, ""); // pending

    expect(strategy.getState().isComputing).toBe(true);
    strategy.cancel();
    expect(strategy.getState().isComputing).toBe(false);
    expect(strategy.getState().computingSnapshotId).toBeUndefined();

    // Resolve the underlying compute — should NOT commit (id no longer
    // matches; pending was dropped).
    gate.resolve();
    await flushMicrotasks();
    expect(strategy.getState().data).toBeUndefined();
    expect(strategy.getState().isComputing).toBe(false);
    strategy.destroy();
  });

  it("cancel() is a no-op when nothing is in flight", () => {
    const strategy = new CoherentDerivationStrategy<
      unknown,
      undefined,
      unknown
    >(new FakeWorker(streamingEchoRunner));
    const before = strategy.getState();
    strategy.cancel();
    expect(strategy.getState()).toEqual(before);
    strategy.destroy();
  });
});

describe("CoherentDerivationStrategy — subscriptions", () => {
  it("notifies subscribers on every commit", async () => {
    const strategy = new CoherentDerivationStrategy<string, undefined, string>(
      new FakeWorker(streamingEchoRunner),
    );
    const calls: number[] = [];
    let count = 0;
    const unsubscribe = strategy.subscribe(() => {
      count += 1;
      calls.push(count);
    });

    strategy.setInputs("a", undefined, "");
    // setInputs commits {isComputing: true} → 1 notification
    await flushMicrotasks();
    // result commits {data: 'a', isComputing: false} → another notification
    expect(count).toBe(2);

    strategy.setInputs("b", undefined, "");
    await flushMicrotasks();
    expect(count).toBe(4);

    unsubscribe();
    strategy.setInputs("c", undefined, "");
    await flushMicrotasks();
    expect(count).toBe(4); // no further notifications after unsubscribe
    strategy.destroy();
  });
});
