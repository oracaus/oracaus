// Bundle-size reporter. Builds the worker and main bundles minified, gzips
// each, and prints raw / gz / % of budget.
//
// `npm test` only gates the budget (silently). For visibility into bundle
// drift over time, run this script — opt-in so it doesn't pollute the
// regular test loop.

import { gzipSync } from "node:zlib";
import { build as esbuild } from "esbuild";

const WORKER_BUDGET_BYTES = 3 * 1024;
const MAIN_BUDGET_BYTES = 8 * 1024;

async function bundle(entry, defines = {}) {
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    minify: true,
    write: false,
    external: ["react"],
    define: defines,
    logLevel: "warning",
  });
  if (result.errors.length > 0) {
    throw new Error(
      `bundle errors: ${result.errors.map((e) => e.text).join("\n")}`,
    );
  }
  return result.outputFiles[0]?.text ?? "";
}

const workerSource = await bundle("src/worker.ts");
const workerGz = gzipSync(workerSource).length;
const workerPct = Math.round((workerGz / WORKER_BUDGET_BYTES) * 100);

const main = await bundle("src/index.ts", {
  __WORKER_SOURCE__: JSON.stringify(workerSource),
});
const mainGz = gzipSync(main).length;
const mainPct = Math.round((mainGz / MAIN_BUDGET_BYTES) * 100);

console.log(
  `worker: ${workerSource.length} B raw, ${workerGz} B gz (${workerPct}% of ${WORKER_BUDGET_BYTES} B gz budget)`,
);
console.log(
  `main:   ${main.length} B raw, ${mainGz} B gz (${mainPct}% of ${MAIN_BUDGET_BYTES} B gz budget)`,
);
