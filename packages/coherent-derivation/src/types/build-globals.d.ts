// Build-time global injected via esbuild's `define` substitution
// (`scripts/build.mjs`). `__WORKER_SOURCE__` holds the bundled worker source
// from `src/worker.ts` as a self-contained ESM string; consumed by
// `internal/worker-bootstrap.ts`.
declare const __WORKER_SOURCE__: string;
