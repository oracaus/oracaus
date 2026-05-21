// Cast helper for tests injecting `FakeWorker` through the public
// `workerFactory: () => Worker` option. The fake structurally implements
// the methods the strategy actually uses (`postMessage`, `addEventListener`,
// `removeEventListener`, `terminate`), but it's not a nominal `Worker`.
//
// The cast is centralised here so the smell is in one place rather than
// scattered across every hook test.

import type { FakeWorker } from "./fake-worker.js";

export function asWorker(fake: FakeWorker): Worker {
  return fake as unknown as Worker;
}
