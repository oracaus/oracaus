// Type-level surface tests. These assert the *types* the public API exposes
// rather than runtime behaviour. They catch accidental drift across
// future refactors — e.g. a generic that loses inference, a return-shape
// that gains a property, an option that becomes incorrectly optional.
//
// Compile-time only: vitest discovers `*.test-d.ts` files and runs the type
// checker over them as part of `vitest --typecheck`. The `expectTypeOf` API
// is from vitest. Tests inside `it.skip` blocks are scaffolding for the
// type-checker; the runtime call is intentionally never executed.
//
// Post-v0.5 refactor: the public surface no longer has a `strategy` literal
// or a single `inputs` option. Inputs split into `streaming` (changes
// absorb) and `intent` (changes cancel-and-restart); compute takes the
// `{ streaming, intent }` envelope.

import { describe, expectTypeOf, it } from "vitest";
import {
  type AbortRequest,
  type CoherentDerivationResult,
  type ComputeRequest,
  type ErrorResponse,
  type ResultResponse,
  type SerializedError,
  type SnapshotId,
  type Source,
  type UseCoherentDerivation,
  type UseCoherentDerivationOptions,
  type useCallbackSource,
  useCoherentDerivation,
  type useEventSource,
  type WorkerCrashResponse,
  type WorkerInbound,
  type WorkerOutbound,
} from "../src/index.js";

describe("API surface — UseCoherentDerivationOptions shape", () => {
  type Opts = UseCoherentDerivationOptions<number, string, boolean>;
  type ComputeFnFor = (
    inputs: { streaming: number; intent: string },
    signal: AbortSignal,
  ) => Promise<boolean>;

  it("streaming and intent slots accept either a raw value or a matching Source", () => {
    expectTypeOf<Opts["streaming"]>().toEqualTypeOf<
      number | Source<number> | undefined
    >();
    expectTypeOf<Opts["intent"]>().toEqualTypeOf<
      string | Source<string> | undefined
    >();
  });

  it("compute is optional at the union level — one branch has it required, the other absent", () => {
    // The discriminated union exposes `compute: ComputeFn | undefined` when
    // accessed flatly; per-branch, the inline-compute variant requires it
    // and the bundled-worker variant treats it as optional.
    expectTypeOf<Opts["compute"]>().toEqualTypeOf<ComputeFnFor | undefined>();
  });

  it("workerFactory is optional at the union level — required in the bundled-worker branch", () => {
    expectTypeOf<Opts["workerFactory"]>().toEqualTypeOf<
      (() => Worker) | undefined
    >();
  });

  it("accepts inline-compute shape (compute required, workerFactory absent)", () => {
    it.skip("scaffolding only", () => {
      useCoherentDerivation<number, string, boolean>({
        streaming: 1,
        intent: "x",
        compute: async ({ streaming }) => streaming > 0,
      });
    });
  });

  it("accepts bundled-worker shape (workerFactory required, compute absent)", () => {
    it.skip("scaffolding only", () => {
      useCoherentDerivation<number, string, boolean>({
        streaming: 1,
        intent: "x",
        workerFactory: () => new Worker(""),
      });
    });
  });

  it("rejects an options object with neither compute nor workerFactory", () => {
    it.skip("scaffolding only", () => {
      useCoherentDerivation<number, string, boolean>(
        // @ts-expect-error — must supply `compute` or `workerFactory`.
        {
          streaming: 1,
          intent: "x",
        },
      );
    });
  });
});

describe("API surface — CoherentDerivationResult shape", () => {
  it("exposes data, isComputing, snapshot ids, error, cancel — all readonly", () => {
    type Result = CoherentDerivationResult<{ x: number }>;
    expectTypeOf<Result>().toEqualTypeOf<{
      readonly data: { x: number } | undefined;
      readonly isComputing: boolean;
      readonly dataSnapshotId: string | undefined;
      readonly computingSnapshotId: string | undefined;
      readonly error: unknown;
      readonly cancel: () => void;
    }>();
  });

  it("data is `TOutput | undefined`, never widened to `unknown`", () => {
    type DataOf<T> = CoherentDerivationResult<T>["data"];
    expectTypeOf<DataOf<number>>().toEqualTypeOf<number | undefined>();
    expectTypeOf<DataOf<{ a: 1 }>>().toEqualTypeOf<{ a: 1 } | undefined>();
  });
});

describe("API surface — useCoherentDerivation generic inference", () => {
  it("infers TStreaming, TIntent, TOutput from options.compute envelope", () => {
    // The runtime call is never executed (the test is type-level only).
    // The assertions below check that TypeScript inferred the right types.
    it.skip("scaffolding only", () => {
      const result = useCoherentDerivation({
        streaming: { value: 7 },
        compute: async ({
          streaming,
        }: {
          streaming: { value: number };
          intent: undefined;
        }) => streaming.value.toString(),
      });
      expectTypeOf(result.data).toEqualTypeOf<string | undefined>();
      expectTypeOf(result.dataSnapshotId).toEqualTypeOf<string | undefined>();
      expectTypeOf(result.cancel).toEqualTypeOf<() => void>();
    });
  });

  it("the function-type alias matches the actual export", () => {
    expectTypeOf(useCoherentDerivation).toMatchTypeOf<UseCoherentDerivation>();
  });
});

describe("API surface — Source helpers", () => {
  it("useCallbackSource returns a stable [Source<T>, push] tuple", () => {
    type CallbackReturn = ReturnType<typeof useCallbackSource<number>>;
    expectTypeOf<CallbackReturn>().toEqualTypeOf<
      readonly [Source<number>, (value: number) => void]
    >();
  });

  it("useEventSource accepts a subscribe-shaped function and returns Source<T>", () => {
    type Subscribe = (push: (value: number) => void) => () => void;
    type EventReturn = ReturnType<typeof useEventSource<number>>;
    expectTypeOf<EventReturn>().toEqualTypeOf<Source<number>>();
    // T is inferred from the subscribe-fn's push-callback parameter.
    expectTypeOf<
      Parameters<typeof useEventSource<number>>[0]
    >().toMatchTypeOf<Subscribe>();
    expectTypeOf<Parameters<typeof useEventSource<number>>[1]>().toEqualTypeOf<
      number | undefined
    >();
  });
});

describe("API surface — worker protocol", () => {
  it("SnapshotId is exported and matches the id field on wire messages", () => {
    // `SnapshotId` is opaque to adopters but they need to name it in helper
    // signatures (e.g. correlating ids across batches). The brand prevents
    // adopters from constructing values directly; type-level it's a string
    // subtype that satisfies wire-message field shapes.
    expectTypeOf<ComputeRequest["id"]>().toEqualTypeOf<SnapshotId>();
    expectTypeOf<AbortRequest["id"]>().toEqualTypeOf<SnapshotId>();
    expectTypeOf<ResultResponse["id"]>().toEqualTypeOf<SnapshotId>();
    expectTypeOf<ErrorResponse["id"]>().toEqualTypeOf<SnapshotId>();
    expectTypeOf<SnapshotId>().toMatchTypeOf<string>();
  });

  it("inbound and outbound discriminated unions cover the published variants", () => {
    // If a future change adds or renames a variant, these assertions
    // compile-fail and force the protocol audit to revisit. Discriminant
    // is on `type`.
    expectTypeOf<WorkerInbound["type"]>().toEqualTypeOf<"compute" | "abort">();
    expectTypeOf<WorkerOutbound["type"]>().toEqualTypeOf<
      "result" | "error" | "worker-error"
    >();
  });

  it("ComputeRequest carries inputs + optional source", () => {
    expectTypeOf<ComputeRequest["type"]>().toEqualTypeOf<"compute">();
    expectTypeOf<ComputeRequest["inputs"]>().toEqualTypeOf<unknown>();
    expectTypeOf<ComputeRequest["source"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  it("AbortRequest is the id-only inbound variant", () => {
    expectTypeOf<AbortRequest["type"]>().toEqualTypeOf<"abort">();
    type AbortKeys = keyof AbortRequest;
    // `type` and `id`; nothing else. If the protocol gains an abort-reason
    // field in the future, this fails and forces a versioned update.
    expectTypeOf<AbortKeys>().toEqualTypeOf<"type" | "id">();
  });

  it("ResultResponse carries the type-erased output", () => {
    expectTypeOf<ResultResponse["type"]>().toEqualTypeOf<"result">();
    expectTypeOf<ResultResponse["output"]>().toEqualTypeOf<unknown>();
  });

  it("ErrorResponse and WorkerCrashResponse carry a SerializedError", () => {
    expectTypeOf<ErrorResponse["type"]>().toEqualTypeOf<"error">();
    expectTypeOf<ErrorResponse["error"]>().toEqualTypeOf<SerializedError>();
    expectTypeOf<WorkerCrashResponse["type"]>().toEqualTypeOf<"worker-error">();
    expectTypeOf<
      WorkerCrashResponse["error"]
    >().toEqualTypeOf<SerializedError>();
    // WorkerCrashResponse has no `id` — there's no in-flight compute to
    // correlate against; the worker process is dead.
    type CrashKeys = keyof WorkerCrashResponse;
    expectTypeOf<CrashKeys>().toEqualTypeOf<"type" | "error">();
  });

  it("SerializedError exposes name + message and optionally stack", () => {
    expectTypeOf<SerializedError["name"]>().toEqualTypeOf<string>();
    expectTypeOf<SerializedError["message"]>().toEqualTypeOf<string>();
    expectTypeOf<SerializedError["stack"]>().toEqualTypeOf<
      string | undefined
    >();
  });
});

describe("API surface — invalid usage fails type-check", () => {
  it("rejects a compute whose signature doesn't return a Promise", () => {
    it.skip("scaffolding only", () => {
      useCoherentDerivation({
        streaming: 1,
        // @ts-expect-error — compute must return Promise, not a bare value.
        compute: ({ streaming }) => streaming,
      });
    });
  });

  it("does not allow assignment to readonly result fields", () => {
    it.skip("scaffolding only", () => {
      const r: CoherentDerivationResult<number> = {
        data: 1,
        isComputing: false,
        dataSnapshotId: "snap-1",
        computingSnapshotId: undefined,
        error: undefined,
        cancel: () => {},
      };
      // @ts-expect-error — `data` is readonly.
      r.data = 2;
    });
  });
});
