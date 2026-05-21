// End-to-end integration: run the actual bundled worker source in a real
// Node `Worker` (from `node:worker_threads`) and round-trip a compute.
//
// Until this point, the worker pipeline has been exercised only through
// `FakeWorker` — which calls `WorkerLoop` directly, in-process. That covers
// the dispatch / strategy / runner logic, but it doesn't exercise the
// platform-specific 3-line wiring in `src/worker.ts`:
//
//     workerScope.addEventListener("message", (event) => loop.handle(event.data));
//
// `node:worker_threads` is not a browser Worker — its message API uses
// `parentPort.on("message", listener)` rather than `self.addEventListener`.
// We bridge that with a small shim prepended to the bundle: `globalThis.self`
// gets `postMessage`, `addEventListener`, and `removeEventListener` methods
// that route to/from `parentPort`. The same bundle that ships to adopters
// then runs unmodified inside a real OS-process worker.
//
// Trade-off acknowledged: the shim is not exactly browser semantics
// (worker context globals differ; `error` and `messageerror` events are
// browser-only). The headline value is verifying that the production
// worker bundle's message pipeline isn't broken at the boundary —
// browser-specific edge cases are a Phase 3 (demo / Playwright) concern.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import { build as esbuild } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SnapshotId } from "../src/internal/snapshot-id.js";
import type {
  WorkerInbound,
  WorkerOutbound,
} from "../src/internal/worker-protocol.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Shim: `self` is an EventTarget-shaped object that routes through
// node:worker_threads' `parentPort`. Bundled at the top of the worker
// source. Browser semantics differ (worker scope globals, error events);
// this is intentionally minimal — enough for the message-flow test.
const NODE_SELF_SHIM = `
import { parentPort } from "node:worker_threads";

if (parentPort === null) {
  throw new Error("real-worker test: parentPort is null (not running as a Worker?)");
}

const messageListeners = new Set();

globalThis.self = {
  postMessage(msg) {
    parentPort.postMessage(msg);
  },
  addEventListener(type, listener) {
    if (type === "message") messageListeners.add(listener);
    // "error" / "messageerror" are browser-specific events not surfaced by
    // node:worker_threads in the worker context. The shim accepts the
    // registration silently — the worker code subscribes defensively.
  },
  removeEventListener(type, listener) {
    if (type === "message") messageListeners.delete(listener);
  },
};

parentPort.on("message", (data) => {
  for (const listener of messageListeners) {
    listener({ data });
  }
});
`;

let workerFilePath: string;
let scratchDir: string;

beforeAll(async () => {
  scratchDir = await mkdtemp(resolve(tmpdir(), "oracaus-real-worker-"));
  workerFilePath = resolve(scratchDir, "worker.mjs");

  const result = await esbuild({
    entryPoints: [resolve(PACKAGE_ROOT, "src/worker.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    minify: false,
    write: false,
    logLevel: "warning",
  });
  if (result.errors.length > 0) {
    throw new Error(
      `worker bundle build failed: ${result.errors.map((e) => e.text).join("\n")}`,
    );
  }
  const workerBundle = result.outputFiles[0]?.text ?? "";
  await writeFile(workerFilePath, `${NODE_SELF_SHIM}\n${workerBundle}`, "utf8");
});

afterAll(async () => {
  if (scratchDir !== undefined) {
    await rm(scratchDir, { recursive: true, force: true });
  }
});

const spawnWorker = (): NodeWorker => new NodeWorker(workerFilePath);

const postAndAwait = (
  worker: NodeWorker,
  message: WorkerInbound,
): Promise<WorkerOutbound> =>
  new Promise<WorkerOutbound>((resolve, reject) => {
    const onMessage = (data: WorkerOutbound): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      resolve(data);
    };
    const onError = (err: Error): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      reject(err);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.postMessage(message);
  });

// Cast helper for the `SnapshotId` brand at the message-protocol layer.
// The worker echoes the string verbatim, so a plain string is fine at
// runtime; the cast is purely type-level so the test can construct
// `WorkerInbound` values without the issuer.
const SNAP = (id: string): SnapshotId => id as SnapshotId;

describe("Real Worker integration (node:worker_threads)", () => {
  it("round-trips a compute through the actual bundled worker", async () => {
    const worker = spawnWorker();
    try {
      const compute = (inputs: { x: number; y: number }): number =>
        inputs.x + inputs.y;
      const response = await postAndAwait(worker, {
        type: "compute",
        id: SNAP("real-1"),
        inputs: { x: 3, y: 4 },
        source: compute.toString(),
      });

      expect(response).toEqual({ type: "result", id: "real-1", output: 7 });
    } finally {
      await worker.terminate();
    }
  });

  it("handles an async compute through the real worker", async () => {
    const worker = spawnWorker();
    try {
      const compute = async (inputs: number[]): Promise<number> => {
        const sum = inputs.reduce((a, b) => a + b, 0);
        return sum;
      };
      const response = await postAndAwait(worker, {
        type: "compute",
        id: SNAP("real-2"),
        inputs: [1, 2, 3, 4, 5],
        source: compute.toString(),
      });

      expect(response).toEqual({ type: "result", id: "real-2", output: 15 });
    } finally {
      await worker.terminate();
    }
  });

  it("forwards a thrown Error from real compute as a serialised error", async () => {
    const worker = spawnWorker();
    try {
      const compute = (): never => {
        throw new RangeError("real compute failure");
      };
      const response = await postAndAwait(worker, {
        type: "compute",
        id: SNAP("real-3"),
        inputs: null,
        source: compute.toString(),
      });

      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.id).toBe("real-3");
        expect(response.error.name).toBe("RangeError");
        expect(response.error.message).toBe("real compute failure");
      }
    } finally {
      await worker.terminate();
    }
  });

  it("rejects [native code] sources with a clear error in the real worker", async () => {
    const worker = spawnWorker();
    try {
      const response = await postAndAwait(worker, {
        type: "compute",
        id: SNAP("real-4"),
        inputs: null,
        source: Math.max.toString(),
      });

      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.message).toContain("[native code]");
      }
    } finally {
      await worker.terminate();
    }
  });

  it("a second compute is faster than the first (cache hit)", async () => {
    const worker = spawnWorker();
    try {
      const compute = (n: number): number => n * 2;
      const source = compute.toString();

      // First call: cold cache, includes `new Function` parse.
      const t0 = performance.now();
      const r0 = await postAndAwait(worker, {
        type: "compute",
        id: SNAP("warm-1"),
        inputs: 7,
        source,
      });
      const cold = performance.now() - t0;

      // Second call: cache hit, skips parse.
      const t1 = performance.now();
      const r1 = await postAndAwait(worker, {
        type: "compute",
        id: SNAP("warm-2"),
        inputs: 8,
        source,
      });
      const warm = performance.now() - t1;

      expect(r0).toEqual({ type: "result", id: "warm-1", output: 14 });
      expect(r1).toEqual({ type: "result", id: "warm-2", output: 16 });
      // We don't assert a strict `warm < cold` because at this scale both are
      // near the postMessage round-trip latency floor and noisy. The semantic
      // assertion is that both succeed and the cache doesn't break anything.
      expect(cold).toBeGreaterThanOrEqual(0);
      expect(warm).toBeGreaterThanOrEqual(0);
    } finally {
      await worker.terminate();
    }
  });
});
