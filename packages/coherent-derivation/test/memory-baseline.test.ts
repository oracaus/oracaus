// Memory-stability baselines for the strategy state machines.
//
// Two layers of check:
//   1. Behavioural: 10k mount/destroy cycles and 10k compute/cancel cycles
//      complete within a generous time budget. Linear time in cycle count is
//      what we expect; quadratic time would surface as a budget breach,
//      which usually points at listener / map accumulation.
//   2. Heap (opt-in via `node --expose-gc`): after a forced GC at start and
//      end, heap delta across 10k cycles stays under a documented bound.
//      The test self-skips when `--expose-gc` isn't available so `npm test`
//      stays green; `npm run bench:memory` exercises the gated check.

import { describe, expect, it } from "vitest";
import { CoherentDerivationStrategy } from "../src/internal/strategies/derivation-strategy.js";
import { FakeWorker } from "./utils/fake-worker.js";

const MOUNT_CYCLES = 10_000;
const COMPUTE_CANCEL_CYCLES = 10_000;
// 1 second is generous on CI; locally these tests run in ~50–200 ms each.
const RUNTIME_BUDGET_MS = 1_000;
// 8 MiB allows for V8's internal-buffer reshuffles + vitest framework
// overhead while still catching a per-cycle leak (a 0.8 KB leak per cycle
// would breach this budget).
const HEAP_DELTA_BUDGET_BYTES = 8 * 1024 * 1024;

const hasGc = typeof globalThis.gc === "function";

describe("memory baseline — streaming inputs", () => {
  it(`${MOUNT_CYCLES} mount/destroy cycles complete in under ${RUNTIME_BUDGET_MS}ms`, () => {
    const start = performance.now();
    for (let i = 0; i < MOUNT_CYCLES; i += 1) {
      const worker = new FakeWorker();
      const strategy = new CoherentDerivationStrategy<
        number,
        undefined,
        number
      >(worker);
      strategy.destroy();
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(RUNTIME_BUDGET_MS);
  });

  it(`${COMPUTE_CANCEL_CYCLES} setInputs/cancel cycles complete in under ${RUNTIME_BUDGET_MS}ms`, () => {
    const worker = new FakeWorker();
    const strategy = new CoherentDerivationStrategy<number, undefined, number>(
      worker,
    );
    const start = performance.now();
    for (let i = 0; i < COMPUTE_CANCEL_CYCLES; i += 1) {
      strategy.setInputs(i, undefined, "");
      strategy.cancel();
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(RUNTIME_BUDGET_MS);
    strategy.destroy();
  });

  it.skipIf(!hasGc)(
    `heap delta after ${MOUNT_CYCLES} mount/destroy cycles is under ${HEAP_DELTA_BUDGET_BYTES / 1024 / 1024} MiB`,
    () => {
      globalThis.gc?.();
      const baseline = process.memoryUsage().heapUsed;

      for (let i = 0; i < MOUNT_CYCLES; i += 1) {
        const worker = new FakeWorker();
        const strategy = new CoherentDerivationStrategy<
          number,
          undefined,
          number
        >(worker);
        strategy.destroy();
      }

      globalThis.gc?.();
      const final = process.memoryUsage().heapUsed;
      const delta = final - baseline;
      expect(delta).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);
    },
  );
});

describe("memory baseline — intent inputs", () => {
  it(`${MOUNT_CYCLES} mount/destroy cycles complete in under ${RUNTIME_BUDGET_MS}ms`, () => {
    const start = performance.now();
    for (let i = 0; i < MOUNT_CYCLES; i += 1) {
      const worker = new FakeWorker();
      const strategy = new CoherentDerivationStrategy<
        undefined,
        number,
        number
      >(worker);
      strategy.destroy();
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(RUNTIME_BUDGET_MS);
  });

  it(`${COMPUTE_CANCEL_CYCLES} setInputs/cancel cycles complete in under ${RUNTIME_BUDGET_MS}ms`, () => {
    const worker = new FakeWorker();
    const strategy = new CoherentDerivationStrategy<undefined, number, number>(
      worker,
    );
    const start = performance.now();
    for (let i = 0; i < COMPUTE_CANCEL_CYCLES; i += 1) {
      // Value rides in the intent slot — this is the intent-driven
      // cancel-and-restart path, distinct from the streaming-conflate
      // path exercised by the sibling describe.
      strategy.setInputs(undefined, i, "");
      strategy.cancel();
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(RUNTIME_BUDGET_MS);
    strategy.destroy();
  });

  it.skipIf(!hasGc)(
    `heap delta after ${MOUNT_CYCLES} mount/destroy cycles is under ${HEAP_DELTA_BUDGET_BYTES / 1024 / 1024} MiB`,
    () => {
      globalThis.gc?.();
      const baseline = process.memoryUsage().heapUsed;

      for (let i = 0; i < MOUNT_CYCLES; i += 1) {
        const worker = new FakeWorker();
        const strategy = new CoherentDerivationStrategy<
          undefined,
          number,
          number
        >(worker);
        strategy.destroy();
      }

      globalThis.gc?.();
      const final = process.memoryUsage().heapUsed;
      const delta = final - baseline;
      expect(delta).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);
    },
  );
});
