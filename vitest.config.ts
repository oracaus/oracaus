import { defineConfig } from "vitest/config";

// Test layout convention (decided in the post-Phase-1 evaluation):
// tests live in a separate `test/` directory at each package root, not
// colocated alongside source. Rationale:
//   - The published library (`@oracaus/coherent-derivation`) ships `src/`
//     to npm so adopters' bundlers can resolve sourcemaps. Colocated
//     `*.test.ts` files would bloat the tarball or require a build step
//     to strip them.
//   - Source listings stay free of test scaffolding when reviewing the
//     library surface.
//   - Test utilities (`test/utils/`) live with the tests they support
//     rather than next to runtime code.
//
// Adopters who prefer colocation can run their own conventions; the
// library is convention-agnostic at the published-package level.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/*/test/**/*.test.{ts,tsx}",
      "demo/test/**/*.test.{ts,tsx}",
    ],
    passWithNoTests: true,
    // Type-level assertions in `*.test-d.ts` files (`expectTypeOf`) and all
    // `*.test.ts` files are checked by `npm run typecheck` via the
    // package-level `tsconfig.test.json`. Vitest's separate typecheck mode
    // is redundant given that pipeline.
    benchmark: {
      include: ["packages/*/bench/**/*.bench.ts", "demo/bench/**/*.bench.ts"],
      outputFile: "bench/results.json",
    },
  },
});
