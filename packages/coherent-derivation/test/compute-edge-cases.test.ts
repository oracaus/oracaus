// Compute-function edge cases. Things adopters might do that aren't the
// happy path but the library must still handle gracefully — sync throws,
// non-Promise returns, rejection with non-Error values, attempted closure
// captures.

import { describe, expect, it } from "vitest";
import { SnapshotIssuer } from "../src/internal/snapshot-id.js";
import { CoherentDerivationStrategy } from "../src/internal/strategies/derivation-strategy.js";
import {
  createProductionRunner,
  WorkerLoop,
} from "../src/internal/worker-loop.js";
import type { WorkerOutbound } from "../src/internal/worker-protocol.js";
import { FakeWorker } from "./utils/fake-worker.js";
import { computeRequest } from "./utils/messages.js";

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("compute edge cases — synchronous throw", () => {
  it("a compute that throws synchronously surfaces as ErrorResponse", async () => {
    // Adopter's compute might be a non-async function that throws sync.
    // `productionRunner` calls `await fn(...)`, which awaits whatever fn
    // returns OR catches the sync throw via the surrounding async.
    const compute = (_inputs: unknown, _signal: AbortSignal): never => {
      throw new TypeError("sync boom");
    };
    const { runner } = createProductionRunner();
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(runner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    loop.handle(computeRequest(id, null, compute.toString()));
    await flushMicrotasks();

    expect(replies).toHaveLength(1);
    const reply = replies[0];
    if (reply?.type !== "error") {
      throw new Error(`expected error, got ${reply?.type}`);
    }
    expect(reply.error.name).toBe("TypeError");
    expect(reply.error.message).toBe("sync boom");
  });
});

describe("compute edge cases — non-Promise return", () => {
  it("a sync compute that returns a value (not a Promise) commits as result", async () => {
    const compute = (inputs: number, _signal: AbortSignal): number =>
      inputs * 3;
    const { runner } = createProductionRunner();
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(runner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    loop.handle(computeRequest(id, 5, compute.toString()));
    await flushMicrotasks();

    expect(replies).toEqual([{ type: "result", id, output: 15 }]);
  });
});

describe("compute edge cases — rejection with non-Error value", () => {
  it("rejecting with a string surfaces as a synthetic Error response", async () => {
    const compute = async (_i: unknown, _s: AbortSignal): Promise<never> => {
      throw "string-thrown" as unknown as Error;
    };
    const { runner } = createProductionRunner();
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(runner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    loop.handle(computeRequest(id, null, compute.toString()));
    await flushMicrotasks();

    expect(replies).toHaveLength(1);
    const reply = replies[0];
    if (reply?.type !== "error") {
      throw new Error(`expected error, got ${reply?.type}`);
    }
    // `serializeError` wraps non-Error throws as `{ name: "NonErrorThrown" }`.
    expect(reply.error.name).toBe("NonErrorThrown");
    expect(reply.error.message).toBe("string-thrown");
  });

  it("rejecting with a plain object surfaces as a synthetic Error response", async () => {
    const compute = async (): Promise<never> => {
      throw { kind: "domain", code: 42 } as unknown as Error;
    };
    const { runner } = createProductionRunner();
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(runner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    loop.handle(computeRequest(id, null, compute.toString()));
    await flushMicrotasks();

    const reply = replies[0];
    if (reply?.type !== "error") {
      throw new Error(`expected error, got ${reply?.type}`);
    }
    expect(reply.error.name).toBe("NonErrorThrown");
    // JSON-serialised representation of the thrown object.
    expect(reply.error.message).toContain("domain");
  });
});

describe("compute edge cases — closure capture (no escape from worker scope)", () => {
  it("a closure-capturing compute fails at runtime when reconstructed", async () => {
    // The adopter writes compute that closes over `secret`. When
    // `compute.toString()` serialises it, the captured variable doesn't
    // travel — the body refers to a name that's not defined in the worker
    // scope. The worker invokes the reconstructed function and gets a
    // ReferenceError, which surfaces as an ErrorResponse.
    const secret = 42;
    const compute = (n: number, _signal: AbortSignal): number => n + secret;

    const { runner } = createProductionRunner();
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(runner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    loop.handle(computeRequest(id, 1, compute.toString()));
    await flushMicrotasks();

    const reply = replies[0];
    expect(reply?.type).toBe("error");
    if (reply?.type === "error") {
      expect(reply.error.name).toBe("ReferenceError");
    }
  });
});

describe("compute edge cases — strategy receives synthetic errors as `error: Error`", () => {
  it("end-to-end through CoherentDerivationStrategy: non-Error throw becomes Error in state", async () => {
    const fake = new FakeWorker(async () => {
      throw "rejected-string";
    });
    const strategy = new CoherentDerivationStrategy<number, undefined, number>(
      fake,
    );

    strategy.setInputs(1, undefined, "");
    await flushMicrotasks();

    const state = strategy.getState();
    expect(state.error).toBeInstanceOf(Error);
    expect((state.error as Error).message).toBe("rejected-string");
    strategy.destroy();
  });
});

describe("compute edge cases — Promise that never resolves (only abort)", () => {
  it("cancel() on a never-resolving compute clears isComputing", async () => {
    const fake = new FakeWorker(
      () => new Promise<never>(() => {}), // never resolves, never rejects
    );
    const strategy = new CoherentDerivationStrategy<number, undefined, number>(
      fake,
    );

    strategy.setInputs(1, undefined, "");
    await flushMicrotasks();
    expect(strategy.getState().isComputing).toBe(true);

    strategy.cancel();
    expect(strategy.getState().isComputing).toBe(false);
    expect(strategy.getState().computingSnapshotId).toBeUndefined();
    strategy.destroy();
  });
});
