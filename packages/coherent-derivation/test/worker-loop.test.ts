import { describe, expect, it, vi } from "vitest";
import { SnapshotIssuer } from "../src/internal/snapshot-id.js";
import {
  type ComputeRunner,
  defaultEchoRunner,
  WorkerLoop,
} from "../src/internal/worker-loop.js";
import type { WorkerOutbound } from "../src/internal/worker-protocol.js";
import { computeRequest } from "./utils/messages.js";

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("WorkerLoop — default echo runner", () => {
  it("replies with a result whose output equals the inputs and id", async () => {
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(defaultEchoRunner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    loop.handle(computeRequest(id, { x: 42, y: "hello" }));
    await flushMicrotasks();

    expect(replies).toEqual([
      { type: "result", id, output: { x: 42, y: "hello" } },
    ]);
  });

  it("preserves identity-tagging across distinct ids", async () => {
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(defaultEchoRunner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id1 = issuer.next();
    const id2 = issuer.next();
    const id3 = issuer.next();

    loop.handle(computeRequest(id1, 1));
    loop.handle(computeRequest(id2, 2));
    loop.handle(computeRequest(id3, 3));
    await flushMicrotasks();

    expect(replies).toEqual([
      { type: "result", id: id1, output: 1 },
      { type: "result", id: id2, output: 2 },
      { type: "result", id: id3, output: 3 },
    ]);
  });

  it("the result id is the exact id sent (no rewrite by the worker)", async () => {
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(defaultEchoRunner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer("custom-prefix");
    const id = issuer.next();

    loop.handle(computeRequest(id, { foo: "bar" }));
    await flushMicrotasks();

    expect(replies).toHaveLength(1);
    const reply = replies[0];
    if (reply?.type !== "result") {
      throw new Error(`expected result, got ${reply?.type}`);
    }
    expect(reply.id).toBe(id);
  });
});

describe("WorkerLoop — productionRunner via source", () => {
  // The production runner reconstructs the user's compute from its serialised
  // source via `new Function(...)`. This test verifies the compute returns
  // the expected output (the value path) rather than the abort path.
  it("invokes the user's compute via reconstructed function source", async () => {
    const { productionRunner } = await import("../src/internal/worker-loop.js");
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(productionRunner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    const compute = (inputs: { x: number; y: number }): Promise<number> =>
      Promise.resolve(inputs.x + inputs.y);

    loop.handle(computeRequest(id, { x: 3, y: 4 }, compute.toString()));
    await flushMicrotasks();

    expect(replies).toEqual([{ type: "result", id, output: 7 }]);
  });
});

describe("WorkerLoop — AbortSignal proxy", () => {
  it("passes a not-yet-aborted signal to the runner on compute", async () => {
    let observedSignal: AbortSignal | undefined;
    const runner: ComputeRunner = async (inputs, signal, _source) => {
      observedSignal = signal;
      return inputs;
    };
    const loop = new WorkerLoop(runner, () => {});
    const issuer = new SnapshotIssuer();

    loop.handle(computeRequest(issuer.next(), null));
    await flushMicrotasks();

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
  });

  it("flips the signal to aborted when an abort message arrives", async () => {
    let observedSignal: AbortSignal | undefined;
    const runner: ComputeRunner = (inputs, signal, _source) =>
      new Promise((resolve) => {
        observedSignal = signal;
        signal.addEventListener("abort", () => resolve(inputs));
      });
    const loop = new WorkerLoop(runner, () => {});
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    loop.handle(computeRequest(id, 7));
    await flushMicrotasks();
    expect(observedSignal?.aborted).toBe(false);

    loop.handle({ type: "abort", id });
    await flushMicrotasks();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not emit a result if the runner resolves after abort", async () => {
    const runner: ComputeRunner = (inputs, signal, _source) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(inputs));
      });
    const reply = vi.fn<(response: WorkerOutbound) => void>();
    const loop = new WorkerLoop(runner, reply);
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    loop.handle(computeRequest(id, "stale"));
    await flushMicrotasks();
    loop.handle({ type: "abort", id });
    await flushMicrotasks();

    expect(reply).not.toHaveBeenCalled();
  });

  it("does not emit an error if the runner rejects after abort", async () => {
    const runner: ComputeRunner = (_inputs, signal, _source) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new Error("post-abort failure")),
        );
      });
    const reply = vi.fn<(response: WorkerOutbound) => void>();
    const loop = new WorkerLoop(runner, reply);
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    loop.handle(computeRequest(id, null));
    await flushMicrotasks();
    loop.handle({ type: "abort", id });
    await flushMicrotasks();

    expect(reply).not.toHaveBeenCalled();
  });

  it("isolates abort to its target id; concurrent computes proceed", async () => {
    const issuer = new SnapshotIssuer();
    const idAbort = issuer.next();
    const idComplete = issuer.next();
    const signals = new Map<string, AbortSignal>();
    const runner: ComputeRunner = (inputs, signal, _source) =>
      new Promise((resolve) => {
        const id = (inputs as { id: string }).id;
        signals.set(id, signal);
        const onAbort = () => resolve({ aborted: true, id });
        signal.addEventListener("abort", onAbort);
        if (id === idComplete) {
          signal.removeEventListener("abort", onAbort);
          resolve({ aborted: false, id });
        }
      });
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(runner, (r) => replies.push(r));

    loop.handle(computeRequest(idAbort, { id: idAbort }));
    loop.handle(computeRequest(idComplete, { id: idComplete }));
    await flushMicrotasks();

    expect(signals.get(idAbort)?.aborted).toBe(false);
    expect(signals.get(idComplete)?.aborted).toBe(false);

    loop.handle({ type: "abort", id: idAbort });
    await flushMicrotasks();

    expect(signals.get(idAbort)?.aborted).toBe(true);
    expect(signals.get(idComplete)?.aborted).toBe(false);
    expect(replies).toEqual([
      {
        type: "result",
        id: idComplete,
        output: { aborted: false, id: idComplete },
      },
    ]);
  });
});

describe("WorkerLoop — error path", () => {
  it("forwards a thrown Error as a serialised error response", async () => {
    const runner: ComputeRunner = async () => {
      throw new TypeError("compute failed");
    };
    const replies: WorkerOutbound[] = [];
    const loop = new WorkerLoop(runner, (r) => replies.push(r));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    loop.handle(computeRequest(id, null));
    await flushMicrotasks();

    expect(replies).toHaveLength(1);
    const reply = replies[0];
    if (reply?.type !== "error") {
      throw new Error(`expected error response, got ${reply?.type}`);
    }
    expect(reply.id).toBe(id);
    expect(reply.error.name).toBe("TypeError");
    expect(reply.error.message).toBe("compute failed");
  });
});
