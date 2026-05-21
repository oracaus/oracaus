import { describe, expect, it } from "vitest";
import { SnapshotIssuer } from "../src/internal/snapshot-id.js";
import { WorkerBridge } from "../src/internal/worker-bridge.js";
import type { WorkerOutbound } from "../src/internal/worker-protocol.js";
import { FakeWorker } from "./utils/fake-worker.js";
import { computeRequest } from "./utils/messages.js";

// `setTimeout(0)` enters the macrotask queue, which guarantees all pending
// microtasks (the runner's await + the FakeWorker's queueMicrotask delivery)
// have drained.
const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("WorkerBridge round-trip", () => {
  it("delivers a result for a compute request with matching id", async () => {
    const fake = new FakeWorker();
    const received: WorkerOutbound[] = [];
    const bridge = new WorkerBridge(fake, (msg) => received.push(msg));
    const issuer = new SnapshotIssuer();
    const id = issuer.next();

    bridge.send(computeRequest(id, { value: 7 }));
    await flushMicrotasks();

    expect(received).toEqual([{ type: "result", id, output: { value: 7 } }]);
    bridge.terminate();
  });

  it("interleaves multiple in-flight requests by id", async () => {
    const fake = new FakeWorker();
    const received: WorkerOutbound[] = [];
    const bridge = new WorkerBridge(fake, (msg) => received.push(msg));
    const issuer = new SnapshotIssuer();
    const idA = issuer.next();
    const idB = issuer.next();
    const idC = issuer.next();

    bridge.send(computeRequest(idA, "alpha"));
    bridge.send(computeRequest(idB, "beta"));
    bridge.send(computeRequest(idC, "gamma"));
    await flushMicrotasks();

    expect(received).toEqual([
      { type: "result", id: idA, output: "alpha" },
      { type: "result", id: idB, output: "beta" },
      { type: "result", id: idC, output: "gamma" },
    ]);
    bridge.terminate();
  });

  it("delivers no further messages after terminate()", async () => {
    const fake = new FakeWorker();
    const received: WorkerOutbound[] = [];
    const bridge = new WorkerBridge(fake, (msg) => received.push(msg));
    const issuer = new SnapshotIssuer();

    bridge.send(computeRequest(issuer.next(), 1));
    await flushMicrotasks();
    expect(received).toHaveLength(1);

    bridge.terminate();
    bridge.send(computeRequest(issuer.next(), 2));
    await flushMicrotasks();

    expect(received).toHaveLength(1);
  });

  it("ignores abort responses (no reply expected from the worker)", async () => {
    const fake = new FakeWorker();
    const received: WorkerOutbound[] = [];
    const bridge = new WorkerBridge(fake, (msg) => received.push(msg));
    const issuer = new SnapshotIssuer();

    bridge.send({ type: "abort", id: issuer.next() });
    await flushMicrotasks();

    expect(received).toEqual([]);
    bridge.terminate();
  });
});
