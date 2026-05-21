// Worker entry. Bundled by `scripts/build.mjs` to a single ESM string and
// inlined into the main library bundle via the `__WORKER_SOURCE__` define;
// at runtime `internal/worker-bootstrap.ts` constructs a Worker from a Blob
// URL. Adopters never load this file directly. The dispatch logic lives in
// `WorkerLoop` (`internal/worker-loop.ts`) so it can be unit-tested in node.

import { productionRunner, WorkerLoop } from "./internal/worker-loop.js";
import type {
  WorkerInbound,
  WorkerOutbound,
} from "./internal/worker-protocol.js";

// `lib: ["DOM"]` types `self` as `Window`, but a dedicated/module worker's
// runtime `self` is `DedicatedWorkerGlobalScope`. The cast bridges the two.
const workerScope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: { data: WorkerInbound }) => void,
  ): void;
  postMessage(message: WorkerOutbound): void;
};

const loop = new WorkerLoop(productionRunner, (response) =>
  workerScope.postMessage(response),
);

workerScope.addEventListener("message", (event) => loop.handle(event.data));
