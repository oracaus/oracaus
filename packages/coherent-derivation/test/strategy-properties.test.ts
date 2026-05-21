// Property-based tests for both strategies. Random operation sequences
// (setInputs / cancel / wait) are applied to a fresh strategy + FakeWorker
// pair; after each run the post-conditions below must hold.
//
// Determinism: vitest defaults aren't deterministic for fast-check seed; we
// pin the seed via a constant so reproducibility is on by default. Failures
// produce a minimal counterexample plus the seed for replay.

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CoherentDerivationStrategy } from "../src/internal/strategies/derivation-strategy.js";
import type { StrategyState } from "../src/internal/strategies/strategy-state.js";
import { FakeWorker } from "./utils/fake-worker.js";

// Drain four microtask ticks: enough to flush the runner's `await`, the
// WorkerLoop's `.then`, the FakeWorker's `queueMicrotask` delivery, and
// any subscriber-driven follow-up commit. Avoids the ~1 ms cost per
// `setTimeout(0)` macrotask, which dominates the property-test runtime
// at 200 runs × ~10 waits per sequence.
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

type Operation =
  | { type: "setInputs"; value: number }
  | { type: "cancel" }
  | { type: "wait" };

const operationArb = fc.oneof(
  fc.record({
    type: fc.constant("setInputs" as const),
    value: fc.integer({ min: 0, max: 1_000 }),
  }),
  fc.record({ type: fc.constant("cancel" as const) }),
  fc.record({ type: fc.constant("wait" as const) }),
);

const sequenceArb = fc.array(operationArb, {
  minLength: 1,
  maxLength: 30,
});

const FAST_CHECK_SEED = 42;
// 100 runs is conservative — 1000 sequences per strategy across 5
// properties is statistically ample for invariant verification, and the
// halved cost is meaningful in a `npm test` loop. Bump locally if a
// regression hunt warrants more thorough fuzzing.
const FAST_CHECK_RUNS = 100;

interface StrategyApi<TInputs, TOutput> {
  setInputs(inputs: TInputs, source: string): void;
  cancel(): void;
  destroy(): void;
  getState(): StrategyState<TOutput>;
  subscribe(listener: () => void): () => void;
}

type StrategyFactory = (worker: FakeWorker) => StrategyApi<number, number>;

// Both fixtures use the unified `CoherentDerivationStrategy`; the difference
// is which slot the input rides in (streaming = absorb, intent = cancel-and-
// restart). Each factory wraps the strategy with the appropriate slot binding
// so the test abstraction `setInputs(value, source)` continues to work without
// changing every callsite.
const strategies: ReadonlyArray<{
  name: string;
  factory: StrategyFactory;
}> = [
  {
    name: "streaming",
    factory: (w): StrategyApi<number, number> => {
      const s = new CoherentDerivationStrategy<number, undefined, number>(w);
      return {
        setInputs: (value, source) => s.setInputs(value, undefined, source),
        cancel: () => s.cancel(),
        destroy: () => s.destroy(),
        getState: () => s.getState(),
        subscribe: (l) => s.subscribe(l),
      };
    },
  },
  {
    name: "intent",
    factory: (w): StrategyApi<number, number> => {
      const s = new CoherentDerivationStrategy<undefined, number, number>(w);
      return {
        setInputs: (value, source) => s.setInputs(undefined, value, source),
        cancel: () => s.cancel(),
        destroy: () => s.destroy(),
        getState: () => s.getState(),
        subscribe: (l) => s.subscribe(l),
      };
    },
  },
];

async function applyOperations(
  strategy: StrategyApi<number, number>,
  ops: ReadonlyArray<Operation>,
): Promise<void> {
  for (const op of ops) {
    switch (op.type) {
      case "setInputs":
        strategy.setInputs(op.value, "");
        break;
      case "cancel":
        strategy.cancel();
        break;
      case "wait":
        await flushMicrotasks();
        break;
    }
  }
}

const parseSnapshotIndex = (id: string | undefined): number =>
  id === undefined ? -1 : Number.parseInt(id.replace(/^[^-]+-/, ""), 10);

for (const { name, factory } of strategies) {
  describe(`Strategy property tests — ${name}`, () => {
    it("state is internally coherent at every quiescent point", async () => {
      await fc.assert(
        fc.asyncProperty(sequenceArb, async (ops) => {
          const worker = new FakeWorker();
          const strategy = factory(worker);
          try {
            await applyOperations(strategy, ops);
            await flushMicrotasks();
            await flushMicrotasks();
            const state = strategy.getState();

            // (1) `isComputing` ↔ `computingSnapshotId` defined.
            expect(state.isComputing).toBe(
              state.computingSnapshotId !== undefined,
            );
            // (2) data ↔ dataSnapshotId: data without an id is impossible;
            //     the inverse (id without data) cannot happen because
            //     dataSnapshotId is only set when data is committed.
            if (state.data !== undefined) {
              expect(state.dataSnapshotId).toBeDefined();
            }
            if (state.dataSnapshotId !== undefined) {
              expect(state.data).toBeDefined();
            }
          } finally {
            strategy.destroy();
          }
        }),
        { seed: FAST_CHECK_SEED, numRuns: FAST_CHECK_RUNS },
      );
    });

    it("dataSnapshotId is monotonically increasing across emitted commits", async () => {
      await fc.assert(
        fc.asyncProperty(sequenceArb, async (ops) => {
          const worker = new FakeWorker();
          const strategy = factory(worker);
          const dataSnapshotIds: string[] = [];
          let lastSeenId: string | undefined;
          const unsub = strategy.subscribe(() => {
            const id = strategy.getState().dataSnapshotId;
            if (id !== undefined && id !== lastSeenId) {
              dataSnapshotIds.push(id);
              lastSeenId = id;
            }
          });
          try {
            await applyOperations(strategy, ops);
            await flushMicrotasks();
            await flushMicrotasks();

            // Every dataSnapshotId we ever observed is strictly greater
            // than the prior one (when parsed by the issuer's counter).
            for (let i = 1; i < dataSnapshotIds.length; i += 1) {
              const prev = parseSnapshotIndex(dataSnapshotIds[i - 1]);
              const curr = parseSnapshotIndex(dataSnapshotIds[i]);
              expect(curr).toBeGreaterThan(prev);
            }
          } finally {
            unsub();
            strategy.destroy();
          }
        }),
        { seed: FAST_CHECK_SEED, numRuns: FAST_CHECK_RUNS },
      );
    });

    it("destroy() is followed by no further state notifications", async () => {
      await fc.assert(
        fc.asyncProperty(sequenceArb, async (ops) => {
          const worker = new FakeWorker();
          const strategy = factory(worker);

          await applyOperations(strategy, ops);
          await flushMicrotasks();

          let notifiesAfterDestroy = 0;
          const unsub = strategy.subscribe(() => {
            notifiesAfterDestroy += 1;
          });
          strategy.destroy();
          await flushMicrotasks();
          await flushMicrotasks();
          unsub();

          expect(notifiesAfterDestroy).toBe(0);
        }),
        { seed: FAST_CHECK_SEED, numRuns: FAST_CHECK_RUNS },
      );
    });

    it("worker.terminate is called exactly once on destroy", async () => {
      await fc.assert(
        fc.asyncProperty(sequenceArb, async (ops) => {
          const worker = new FakeWorker();
          let terminateCalls = 0;
          const originalTerminate = worker.terminate.bind(worker);
          worker.terminate = () => {
            terminateCalls += 1;
            originalTerminate();
          };
          const strategy = factory(worker);

          await applyOperations(strategy, ops);
          await flushMicrotasks();

          expect(terminateCalls).toBe(0);
          strategy.destroy();
          expect(terminateCalls).toBe(1);
          // Subsequent destroy() must not double-terminate.
          strategy.destroy();
          expect(terminateCalls).toBe(1);
        }),
        { seed: FAST_CHECK_SEED, numRuns: FAST_CHECK_RUNS },
      );
    });

    it("survives random sequences with mid-stream destroy without throwing", async () => {
      const opWithDestroyArb = fc.array(
        fc.oneof(
          fc.record({
            type: fc.constant("setInputs" as const),
            value: fc.integer({ min: 0, max: 1_000 }),
          }),
          fc.record({ type: fc.constant("cancel" as const) }),
          fc.record({ type: fc.constant("wait" as const) }),
          fc.record({ type: fc.constant("destroy" as const) }),
        ),
        { minLength: 1, maxLength: 30 },
      );

      await fc.assert(
        fc.asyncProperty(opWithDestroyArb, async (ops) => {
          const worker = new FakeWorker();
          const strategy = factory(worker);
          for (const op of ops) {
            switch (op.type) {
              case "setInputs":
                strategy.setInputs(op.value, "");
                break;
              case "cancel":
                strategy.cancel();
                break;
              case "wait":
                await flushMicrotasks();
                break;
              case "destroy":
                strategy.destroy();
                break;
            }
          }
          await flushMicrotasks();
          await flushMicrotasks();
          // The assertion is the absence of any thrown error from any
          // operation — strategies must tolerate any interleaving without
          // corrupting state or attempting to write to terminated workers.
          // Final destroy is idempotent; it's a no-op if already destroyed.
          strategy.destroy();
        }),
        { seed: FAST_CHECK_SEED, numRuns: FAST_CHECK_RUNS },
      );
    });
  });
}
