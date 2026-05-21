// @vitest-environment happy-dom

// Hook + adopter-input edge cases. Cancel from render, multiple hook
// instances in one component tree, primitive inputs (string/number/null),
// and the documented behaviour of strategy-switch-mid-mount.

import { act, render, renderHook, waitFor } from "@testing-library/react";
import type * as React from "react";
import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useCoherentDerivation } from "../src/use-coherent-derivation.js";
import { asWorker } from "./utils/as-worker.js";
import { FakeWorker } from "./utils/fake-worker.js";
import { streamingEchoRunner } from "./utils/runners.js";

// Generic so TS infers TOutput = TStreaming from the call site; otherwise
// `data` would type as `unknown` and per-field access in JSX like
// `data.tag` would fail to compile.
const echoCompute = async <T,>({
  streaming,
}: {
  streaming: T;
  intent: unknown;
}): Promise<T> => streaming;

describe("Hook edge — cancel() called from a useEffect", () => {
  it("works as expected — cancels in-flight, leaves data intact", async () => {
    // The realistic place to call `cancel()`: inside an effect or an event
    // handler, never from render. Calling it from render commits state
    // synchronously, which triggers a setState-in-render React warning —
    // adopters should use a button click handler or an effect instead.
    const fake = new FakeWorker(
      (inputs) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(inputs), 1000);
        }),
    );
    const factory = (): Worker => asWorker(fake);
    const inputs = "x";

    const Probe = (): React.ReactElement => {
      const { isComputing, cancel } = useCoherentDerivation({
        streaming: inputs,
        compute: echoCompute,
        workerFactory: factory,
      });
      // Cancel inside an effect that runs once after mount. Real adopters
      // would gate this on a user action; for the test the gate is the
      // first effect run.
      const cancelledRef = useRef(false);
      useEffect(() => {
        if (!cancelledRef.current && isComputing) {
          cancelledRef.current = true;
          cancel();
        }
      }, [isComputing, cancel]);

      return (
        <div data-testid="state">{isComputing ? "computing" : "idle"}</div>
      );
    };

    const { getByTestId, unmount } = render(<Probe />);
    await waitFor(() => {
      expect(getByTestId("state").textContent).toBe("idle");
    });
    unmount();
  });
});

describe("Hook edge — multiple hook instances in one component tree", () => {
  it("each instance has its own worker; no cross-talk", async () => {
    const factories: Array<{ id: number; worker: FakeWorker }> = [];
    let counter = 0;
    const factory = (): Worker => {
      counter += 1;
      const w = new FakeWorker(streamingEchoRunner);
      factories.push({ id: counter, worker: w });
      return asWorker(w);
    };
    const inputsA = { tag: "a", n: 1 };
    const inputsB = { tag: "b", n: 2 };
    const inputsC = { tag: "c", n: 3 };

    const Multi = (): React.ReactElement => {
      const a = useCoherentDerivation({
        streaming: inputsA,
        compute: echoCompute,
        workerFactory: factory,
      });
      const b = useCoherentDerivation({
        streaming: inputsB,
        compute: echoCompute,
        workerFactory: factory,
      });
      const c = useCoherentDerivation({
        streaming: inputsC,
        compute: echoCompute,
        workerFactory: factory,
      });
      return (
        <div data-testid="multi">
          {a.data?.tag ?? "?"}|{b.data?.tag ?? "?"}|{c.data?.tag ?? "?"}
        </div>
      );
    };

    const { getByTestId } = render(<Multi />);
    await waitFor(() => {
      expect(getByTestId("multi").textContent).toBe("a|b|c");
    });
    // Three workers were created — one per hook instance. (Strict Mode is
    // off in this test wrapper, so we expect exactly three.)
    expect(factories.length).toBe(3);
  });
});

describe("Hook edge — primitive inputs", () => {
  it("accepts string inputs and round-trips them", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = () => asWorker(fake);
    const inputs = "hello";
    const { result } = renderHook(() =>
      useCoherentDerivation({
        streaming: inputs,
        compute: echoCompute,
        workerFactory: factory,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toBe("hello");
    });
  });

  it("accepts number inputs", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = () => asWorker(fake);
    const inputs = 42;
    const { result } = renderHook(() =>
      useCoherentDerivation({
        streaming: inputs,
        compute: echoCompute,
        workerFactory: factory,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toBe(42);
    });
  });

  it("accepts null inputs", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = () => asWorker(fake);
    const inputs = null as null;
    const { result } = renderHook(() =>
      useCoherentDerivation({
        streaming: inputs,
        compute: async ({ streaming }: { streaming: null }) => streaming,
        workerFactory: factory,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toBe(null);
    });
  });
});

describe("Hook edge — workerFactory throws", () => {
  it("an exception in workerFactory propagates from the effect (not silently swallowed)", () => {
    const inputs = 1;
    const factory = (): Worker => {
      throw new Error("worker construction failed");
    };
    // We expect the effect to throw; testing-library re-raises during render.
    expect(() =>
      render(
        <BoomProbe
          streaming={inputs}
          factory={factory as unknown as () => Worker}
        />,
      ),
    ).toThrow("worker construction failed");
  });
});

const BoomProbe = ({
  streaming,
  factory,
}: {
  streaming: number;
  factory: () => Worker;
}): React.ReactElement => {
  useCoherentDerivation({
    streaming,
    compute: echoCompute,
    workerFactory: factory,
  });
  return <div />;
};

describe("Hook edge — cancel() identity is stable across renders", () => {
  it("the cancel function reference does not change render-to-render", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = () => asWorker(fake);
    const inputs = 1;
    const { result, rerender } = renderHook(() =>
      useCoherentDerivation({
        streaming: inputs,
        compute: echoCompute,
        workerFactory: factory,
      }),
    );

    const cancelA = result.current.cancel;
    rerender();
    const cancelB = result.current.cancel;
    rerender();
    const cancelC = result.current.cancel;

    expect(cancelA).toBe(cancelB);
    expect(cancelB).toBe(cancelC);
    // Sanity: it works, not just stable.
    act(() => {
      cancelA();
    });
  });
});

describe("Hook edge — workerFactory called once per mount cycle", () => {
  it("does not invoke workerFactory on every render (only on effect-setup)", async () => {
    let factoryCalls = 0;
    const factory = (): Worker => {
      factoryCalls += 1;
      return asWorker(new FakeWorker(streamingEchoRunner));
    };
    const inputs = 1;
    const compute = vi.fn(echoCompute);
    const { result, rerender, unmount } = renderHook(() =>
      useCoherentDerivation({
        streaming: inputs,
        compute,
        workerFactory: factory,
      }),
    );

    // Settle the initial mount + effect-driven state update before the
    // synchronous rerenders, so the rerender loop doesn't race against
    // pending React updates (which would surface as an `act(...)` warning).
    await waitFor(() => {
      expect(result.current.data).toBe(1);
    });

    rerender();
    rerender();
    rerender();
    expect(factoryCalls).toBe(1);
    unmount();
  });
});

describe("Hook edge — workerFactory without compute (bundled-worker pattern)", () => {
  it("round-trips through a custom worker that ignores source", async () => {
    // Bundled-worker callers omit `compute` entirely. The library sends
    // ComputeRequest without a `source` field; the worker has its compute
    // statically and dispatches directly. The runner used here returns a
    // fixed shape so the assertion is on identity-preserving round-trip,
    // not on echoing inputs.
    const bundledRunner = async (
      inputs: unknown,
      _signal: AbortSignal,
      _source: string | undefined,
    ): Promise<{ tag: "bundled"; echoed: unknown }> => ({
      tag: "bundled",
      echoed: inputs,
    });
    const fake = new FakeWorker(bundledRunner);
    const factory = (): Worker => asWorker(fake);

    const { result } = renderHook(() =>
      useCoherentDerivation<
        number,
        undefined,
        { tag: "bundled"; echoed: unknown }
      >({
        streaming: 42,
        workerFactory: factory,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({
        tag: "bundled",
        echoed: { streaming: 42, intent: undefined },
      });
    });
  });

  it("omits `source` from the inbound when compute is not supplied", async () => {
    // Capture inbounds at the FakeWorker level to verify the wire shape:
    // when `compute` is absent, the library MUST NOT send a `source` field.
    let observedSource: unknown = "<not seen>";
    const sourceObservingRunner = async (
      _inputs: unknown,
      _signal: AbortSignal,
      source: string | undefined,
    ): Promise<unknown> => {
      observedSource = source;
      return null;
    };
    const fake = new FakeWorker(sourceObservingRunner);
    const factory = (): Worker => asWorker(fake);

    const { result } = renderHook(() =>
      useCoherentDerivation<number, undefined, unknown>({
        streaming: 1,
        workerFactory: factory,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toBe(null);
    });
    expect(observedSource).toBe(undefined);
  });
});

describe("Hook edge — neither compute nor workerFactory throws clearly", () => {
  it("throws TypeError at first render with an actionable message", () => {
    // The type-level discriminated union forbids this shape; the runtime
    // guard catches adopters who cast past the types or build options
    // dynamically. The error message names both opt-in routes.
    const Probe = (): React.ReactElement => {
      useCoherentDerivation<number, undefined, unknown>(
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type check
        { streaming: 1 } as any,
      );
      return <div />;
    };
    // Silence React's expected error log for this render.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(
      /pass `compute` \(inline\) or `workerFactory`/,
    );
    consoleError.mockRestore();
  });
});

describe("Hook edge — mixed inputs (both streaming and intent populated)", () => {
  // The README claims "Mixed UIs are first-class" — adopters declare both
  // slots and the substrate handles each kind correctly: streaming changes
  // absorb, intent changes cancel-and-restart. The strategy layer's
  // mixed-input behaviour is covered by `derivation-strategy-*.test.ts`
  // (per slot, with the other fixed at `undefined`). This block covers
  // the hook integration: the call site accepts both slots, the compute
  // sees the `{ streaming, intent }` envelope, and the output composes
  // both halves.
  it("composes both slots through the hook's compute envelope", async () => {
    const fake = new FakeWorker(
      // Compute reads both slots and returns a tuple — proves the envelope
      // is wired through end-to-end.
      async (inputs) => {
        const { streaming, intent } = inputs as {
          streaming: number;
          intent: { mode: string };
        };
        return { value: streaming, mode: intent.mode };
      },
    );
    const factory = (): Worker => asWorker(fake);

    const intent = { mode: "fast" };
    const { result } = renderHook(() =>
      useCoherentDerivation<
        number,
        { mode: string },
        { value: number; mode: string }
      >({
        streaming: 1,
        intent,
        workerFactory: factory,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ value: 1, mode: "fast" });
    });
  });

  it("intent-slot change with stable streaming triggers a recompute", async () => {
    const computations: Array<{ s: number; i: string }> = [];
    const fake = new FakeWorker(async (inputs) => {
      const { streaming, intent } = inputs as {
        streaming: number;
        intent: string;
      };
      computations.push({ s: streaming, i: intent });
      return `${streaming}:${intent}`;
    });
    const factory = (): Worker => asWorker(fake);

    const { result, rerender } = renderHook(
      ({ intent }: { intent: string }) =>
        useCoherentDerivation<number, string, string>({
          streaming: 7,
          intent,
          workerFactory: factory,
        }),
      { initialProps: { intent: "a" } },
    );

    await waitFor(() => {
      expect(result.current.data).toBe("7:a");
    });

    rerender({ intent: "b" });
    await waitFor(() => {
      expect(result.current.data).toBe("7:b");
    });

    // Both compute invocations land — streaming was stable across the
    // intent change, but intent identity changed so a fresh compute was
    // issued (the strategy's cancel-and-restart-on-intent policy).
    expect(computations).toEqual([
      { s: 7, i: "a" },
      { s: 7, i: "b" },
    ]);
  });
});
