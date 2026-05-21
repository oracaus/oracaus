// Bundle-size gate. Builds the library and worker entry minified, then
// gzips each independently. v0.5.0 budgets:
//   - main bundle (worker source inlined as a string): <8 KiB minified gz
//   - worker source (pre-Blob, before being inlined):  <3 KiB minified gz
//
// The main bundle test minifies in-test (the dev build keeps the bundle
// readable; size measurement requires minification). Adopters get the
// minified version when their bundler runs over our output.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build as esbuild } from "esbuild";
import { describe, expect, it } from "vitest";

const MAIN_BUDGET_BYTES = 8 * 1024;
const WORKER_BUDGET_BYTES = 3 * 1024;

// vitest runs from the workspace root; resolve entry paths against this
// package so `src/...` lands in `packages/coherent-derivation/src/...`.
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function bundle(
  entry: string,
  defines: Record<string, string> = {},
): Promise<string> {
  const result = await esbuild({
    entryPoints: [resolve(PACKAGE_ROOT, entry)],
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

describe("bundle size gate", () => {
  it(`worker source bundles to <${WORKER_BUDGET_BYTES} B minified gzipped`, async () => {
    const code = await bundle("src/worker.ts");
    const gz = gzipSync(code).length;
    expect(gz).toBeLessThan(WORKER_BUDGET_BYTES);
  });

  it(`main bundle (with inlined worker) bundles to <${MAIN_BUDGET_BYTES} B minified gzipped`, async () => {
    // Build the worker first so its source can be inlined into the main
    // bundle via the `__WORKER_SOURCE__` define — same pipeline as
    // `scripts/build.mjs`, just with minification on for both stages so the
    // measurement reflects what an adopter's bundler produces.
    const workerSource = await bundle("src/worker.ts");
    const main = await bundle("src/index.ts", {
      __WORKER_SOURCE__: JSON.stringify(workerSource),
    });
    const gz = gzipSync(main).length;
    expect(gz).toBeLessThan(MAIN_BUDGET_BYTES);
  });
});
