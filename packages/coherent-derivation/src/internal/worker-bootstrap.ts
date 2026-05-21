// Constructs a Worker from the bundled worker source inlined at build time.
// `__WORKER_SOURCE__` is replaced with a string literal by esbuild's
// `define` substitution; see `scripts/build.mjs`.
//
// Adopters never call this directly. The hook owns the worker lifecycle;
// this module is the single point at which a Worker comes into existence.

/** @internal */
export function spawnWorker(): Worker {
  const blob = new Blob([__WORKER_SOURCE__], {
    type: "application/javascript",
  });
  const url = URL.createObjectURL(blob);
  // `type: "module"` matches the worker bundle's ESM format (see
  // `scripts/build.mjs` — esbuild emits `format: "esm"`).
  const worker = new Worker(url, { type: "module" });
  // The Blob URL is no longer needed once the Worker has been constructed;
  // the browser holds its own reference until the Worker terminates.
  URL.revokeObjectURL(url);
  return worker;
}
