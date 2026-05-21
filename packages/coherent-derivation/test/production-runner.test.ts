// `productionRunner` reconstructs the user's compute via `new Function`
// from the serialised source string. At React's 60 Hz cadence with a stable
// `compute`, that's up to 60 reparses per second; the cache exists to turn
// this into a single parse + N hashmap lookups.
//
// `createProductionRunner()` returns a runner with a `stats()` accessor so
// tests can directly observe `compileCount` and `cacheSize`.

import { describe, expect, it } from "vitest";
import { SnapshotIssuer } from "../src/internal/snapshot-id.js";
import {
  createProductionRunner,
  WorkerLoop,
} from "../src/internal/worker-loop.js";
import type { WorkerOutbound } from "../src/internal/worker-protocol.js";
import { computeRequest } from "./utils/messages.js";

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const idFunctionSource = "(inputs, _signal) => inputs";
const doubleFunctionSource = "(inputs, _signal) => inputs * 2";

describe("createProductionRunner — cache behaviour", () => {
  it("compiles a source string only once across multiple invocations", async () => {
    const { runner, stats } = createProductionRunner();
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(runner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();

    for (let i = 0; i < 5; i += 1) {
      loop.handle(computeRequest(issuer.next(), i, idFunctionSource));
    }
    await flushMicrotasks();

    expect(replies).toHaveLength(5);
    expect(stats().compileCount).toBe(1);
    expect(stats().cacheSize).toBe(1);
  });

  it("recompiles when the source string changes", async () => {
    const { runner, stats } = createProductionRunner();
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(runner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();

    loop.handle(computeRequest(issuer.next(), 3, idFunctionSource));
    await flushMicrotasks();
    expect(stats().compileCount).toBe(1);

    loop.handle(computeRequest(issuer.next(), 3, doubleFunctionSource));
    await flushMicrotasks();
    expect(stats().compileCount).toBe(2);
    expect(stats().cacheSize).toBe(2);

    // Returning to the first source: cached, no extra compile.
    loop.handle(computeRequest(issuer.next(), 5, idFunctionSource));
    await flushMicrotasks();
    expect(stats().compileCount).toBe(2);
  });

  it("each runner instance has its own cache (no global state)", async () => {
    const a = createProductionRunner();
    const b = createProductionRunner();
    const issuer = new SnapshotIssuer();
    const loopA = new WorkerLoop(a.runner, () => {});
    const loopB = new WorkerLoop(b.runner, () => {});

    loopA.handle(computeRequest(issuer.next(), 1, idFunctionSource));
    await flushMicrotasks();

    expect(a.stats().compileCount).toBe(1);
    expect(b.stats().compileCount).toBe(0);

    loopB.handle(computeRequest(issuer.next(), 1, idFunctionSource));
    await flushMicrotasks();
    expect(b.stats().compileCount).toBe(1);
  });

  it("returns the correct output regardless of cache hit/miss", async () => {
    const { runner } = createProductionRunner();
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(runner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();

    const sumSource = "(xs, _signal) => xs.reduce((a, b) => a + b, 0)";
    loop.handle(computeRequest(issuer.next(), [1, 2, 3], sumSource));
    loop.handle(computeRequest(issuer.next(), [10, 20], sumSource));
    loop.handle(computeRequest(issuer.next(), [100], sumSource));
    await flushMicrotasks();

    expect(replies.map((r) => (r.type === "result" ? r.output : null))).toEqual(
      [6, 30, 100],
    );
  });

  it("propagates [native code] detection through the cache path", async () => {
    const { runner, stats } = createProductionRunner();
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(runner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();

    loop.handle(computeRequest(issuer.next(), 1, Math.max.toString()));
    await flushMicrotasks();

    expect(replies).toHaveLength(1);
    expect(replies[0]?.type).toBe("error");
    // Failed compile is not cached.
    expect(stats().cacheSize).toBe(0);
    expect(stats().compileCount).toBe(0);
  });
});
