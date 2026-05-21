// Build orchestrator for @oracaus/coherent-derivation.
//
// Three-stage pipeline:
//   1. `tsc -b` emits per-file `.d.ts` + composite project-reference info.
//      The .d.ts files are what adopters' TypeScript checker resolves; their
//      runtime imports go through the bundled `dist/index.js` from step 3.
//   2. esbuild bundles `src/worker.ts` to a self-contained ESM string,
//      minified for size. Computed in memory; nothing is written at this
//      stage.
//   3. esbuild bundles `src/index.ts` to `dist/index.js` with `define`
//      substituting the literal worker source for every reference to
//      `__WORKER_SOURCE__`. This overwrites the per-file `dist/index.js`
//      that tsc emitted in step 1.
//
// Result: `dist/index.js` is a single bundled module with the worker source
// inlined; `dist/index.d.ts` is tsc's declaration. No separate worker file
// ships; no bundler-side worker plumbing is required by adopters.

import { execSync } from "node:child_process";
import { build as esbuild } from "esbuild";

execSync("tsc -b", { stdio: "inherit" });

const workerResult = await esbuild({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: true,
  write: false,
  logLevel: "warning",
});

if (workerResult.errors.length > 0) {
  for (const error of workerResult.errors) {
    console.error(error);
  }
  process.exit(1);
}

const workerSource = workerResult.outputFiles[0].text;

await esbuild({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  // Each `__WORKER_SOURCE__` reference in the bundled main entry is replaced
  // with the literal worker source.
  define: {
    __WORKER_SOURCE__: JSON.stringify(workerSource),
  },
  // Don't minify by default — adopters' bundlers minify the library together
  // with their app. Bundle-size CI (Block 10) measures gzipped size against
  // this output.
  minify: false,
  sourcemap: true,
  logLevel: "warning",
  // React is the only peer; nothing else is treated as external. The peerDep
  // is declared in package.json. (Block 7 introduces the React import; this
  // option is here so we don't have to revisit the build at that point.)
  external: ["react"],
});

console.log(
  `[build] worker bundled: ${workerSource.length} bytes (minified, pre-Blob).`,
);
