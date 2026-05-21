// @vitest-environment happy-dom

// Source-based input contract tests for `useCoherentDerivation`. The
// architectural promise of the source-based input shape is:
//
//   1. When the adopter passes a `Source<T>` (e.g. via `useCallbackSource`),
//      the substrate consumes inputs via subscription rather than via prop
//      identity comparison. Pushing N times into the source results in N
//      strategy updates, but does NOT cause the host component to re-render
//      N times — only commits from the strategy do. This is the load-bearing
//      decoupling that motivated the API redesign.
//
//   2. Auto-wrap (passing a value instead of a Source) preserves the
//      existing behaviour. Covered by the broader test suite — this file
//      adds Source-specific tests.
//
//   3. Switching `streaming` from a value to a Source mid-lifetime
//      re-subscribes correctly.
//
//   4. User-source subscribe cleanup fires on unmount.
//
//   5. Strict Mode double-mount: subscribe → cleanup → subscribe, netting
//      one active subscription.
//
//   6. Initial-value semantics — initial value flows through to the
//      strategy's first commit.

import { act, render, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useCallbackSource, useEventSource } from "../src/sources.js";
import { type Source, SourceBrand } from "../src/types.js";
import { useCoherentDerivation } from "../src/use-coherent-derivation.js";
import { asWorker } from "./utils/as-worker.js";
import { FakeWorker } from "./utils/fake-worker.js";
import { streamingEchoRunner } from "./utils/runners.js";

const echoCompute = async <T,>({
  streaming,
}: {
  streaming: T;
  intent: unknown;
}): Promise<T> => streaming;

describe("source-based streaming — values commit correctly when pushed", () => {
  it("first push triggers a compute; result commits", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = (): Worker => asWorker(fake);
    const { result } = renderHook(() => {
      const [source, push] = useCallbackSource<{ x: number }>();
      const derivation = useCoherentDerivation({
        streaming: source,
        compute: echoCompute,
        workerFactory: factory,
      });
      return { derivation, push };
    });

    expect(result.current.derivation.data).toBeUndefined();

    act(() => {
      result.current.push({ x: 42 });
    });

    await waitFor(() => {
      expect(result.current.derivation.data).toEqual({ x: 42 });
    });
  });

  it("subsequent pushes deliver new values to the strategy", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = (): Worker => asWorker(fake);
    const { result } = renderHook(() => {
      const [source, push] = useCallbackSource<number>(0);
      const derivation = useCoherentDerivation({
        streaming: source,
        compute: echoCompute,
        workerFactory: factory,
      });
      return { derivation, push };
    });

    await waitFor(() => {
      expect(result.current.derivation.data).toBe(0);
    });

    act(() => {
      result.current.push(1);
    });
    await waitFor(() => {
      expect(result.current.derivation.data).toBe(1);
    });

    act(() => {
      result.current.push(2);
    });
    await waitFor(() => {
      expect(result.current.derivation.data).toBe(2);
    });
  });
});

describe("source-based streaming — host re-render rate is decoupled from push rate", () => {
  it("pushing N times does NOT trigger N host re-renders", async () => {
    // The architectural promise: a Source-fed streaming input causes host
    // re-renders only on strategy commits (and the initial mount), not on
    // every push. The check spies on a render counter inside the hook
    // consumer and asserts the count stays bounded even under many pushes.
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = (): Worker => asWorker(fake);
    const renderCounter = vi.fn();

    let pushRef: ((v: number) => void) | undefined;
    const Host = (): null => {
      renderCounter();
      const [source, push] = useCallbackSource<number>(0);
      pushRef = push;
      useCoherentDerivation({
        streaming: source,
        compute: echoCompute,
        workerFactory: factory,
      });
      return null;
    };
    render(<Host />);

    await waitFor(() => {
      expect(renderCounter).toHaveBeenCalled();
    });
    const rendersAfterMount = renderCounter.mock.calls.length;

    // Push 100 times in quick succession. Each push notifies the
    // subscription listener (which calls strategy.setInputs) — but
    // setInputs does NOT trigger a host re-render directly. Only strategy
    // commits cause re-renders, and commits happen at the worker's
    // compute cadence, not at the push cadence.
    act(() => {
      for (let i = 1; i <= 100; i++) {
        pushRef?.(i);
      }
    });

    await waitFor(() => {
      expect(renderCounter.mock.calls.length).toBeGreaterThan(
        rendersAfterMount,
      );
    });

    // Critical assertion: total renders is bounded by the number of
    // strategy commits, NOT the number of pushes. 100 pushes through a
    // Source must not produce ~100 host re-renders.
    const totalRenders = renderCounter.mock.calls.length;
    expect(totalRenders).toBeLessThan(20);
  });
});

describe("source-based streaming — switching between value and Source", () => {
  it("starting with a value then switching to a user Source re-subscribes correctly", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = (): Worker => asWorker(fake);
    // Hoist the value-shape outside the renderHook callback so its
    // identity is stable across re-renders. (The same memoisation
    // discipline adopters must apply when passing object literals to
    // `useCoherentDerivation` — without it, the auto-wrap useEffect
    // would fire on every render and feedback-loop with React.)
    const valueShape = { v: 1 };

    const { result, rerender } = renderHook(
      ({ useSource }: { useSource: boolean }) => {
        const [source, push] = useCallbackSource<{ v: number }>({ v: 100 });
        const derivation = useCoherentDerivation({
          streaming: useSource ? source : valueShape,
          compute: echoCompute,
          workerFactory: factory,
        });
        return { derivation, push };
      },
      { initialProps: { useSource: false } },
    );

    // First commit comes from the value path.
    await waitFor(() => {
      expect(result.current.derivation.data).toEqual({ v: 1 });
    });

    // Switch to user-source.
    rerender({ useSource: true });
    await waitFor(() => {
      // Source's initial value is { v: 100 } — strategy gets that on the
      // re-subscription's initial `update()`.
      expect(result.current.derivation.data).toEqual({ v: 100 });
    });

    // Push through the source to verify it's wired.
    act(() => {
      result.current.push({ v: 999 });
    });
    await waitFor(() => {
      expect(result.current.derivation.data).toEqual({ v: 999 });
    });
  });
});

describe("source-based streaming — subscribe / cleanup lifecycle", () => {
  it("unmounts cause user-source subscribe's cleanup to fire", () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = (): Worker => asWorker(fake);
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);

    // Hand-rolled Source so we can spy on subscribe/unsubscribe.
    const handRolledSource: Source<number> = {
      [SourceBrand]: true,
      subscribe,
      getSnapshot: () => 0,
    };

    const { unmount } = renderHook(() =>
      useCoherentDerivation({
        streaming: handRolledSource,
        compute: echoCompute,
        workerFactory: factory,
      }),
    );

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("source-based streaming — Strict Mode", () => {
  it("subscribe cycles: mount → cleanup → mount nets one active subscription", () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = (): Worker => asWorker(fake);
    let activeSubscriptions = 0;

    const subscribe = vi.fn(() => {
      activeSubscriptions += 1;
      return () => {
        activeSubscriptions -= 1;
      };
    });

    const handRolledSource: Source<number> = {
      [SourceBrand]: true,
      subscribe,
      getSnapshot: () => 42,
    };

    const Host = (): null => {
      useCoherentDerivation({
        streaming: handRolledSource,
        compute: echoCompute,
        workerFactory: factory,
      });
      return null;
    };

    const { unmount } = render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );

    // Strict Mode: mount → cleanup → mount. Subscribe fires twice and
    // unsubscribe fires once during dev-mode double-invoke. After
    // settling, exactly one active subscription remains.
    expect(activeSubscriptions).toBe(1);

    unmount();
    expect(activeSubscriptions).toBe(0);
  });
});

describe("useCallbackSource — initial-value semantics through the hook", () => {
  it("with explicit initial: strategy receives the initial value on first commit", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = (): Worker => asWorker(fake);
    const { result } = renderHook(() => {
      const [source] = useCallbackSource<{ v: number }>({ v: 7 });
      return useCoherentDerivation({
        streaming: source,
        compute: echoCompute,
        workerFactory: factory,
      });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ v: 7 });
    });
  });
});

describe("useEventSource — end-to-end through useCoherentDerivation", () => {
  it("feed pushes deliver values to the substrate without host re-renders per push", async () => {
    // The integrated test of useEventSource's load-bearing claim: a
    // subscribe-shaped feed pushing at high rate must NOT trigger a host
    // re-render per push. Re-renders happen at substrate commit cadence
    // only.
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = (): Worker => asWorker(fake);
    const renderCounter = vi.fn();

    let registeredPush: ((value: number) => void) | undefined;
    const subscribeFeed = (push: (value: number) => void): (() => void) => {
      registeredPush = push;
      return () => {
        registeredPush = undefined;
      };
    };

    const Host = (): null => {
      renderCounter();
      const numberSource = useEventSource<number>(subscribeFeed, 0);
      useCoherentDerivation({
        streaming: numberSource,
        compute: echoCompute,
        workerFactory: factory,
      });
      return null;
    };
    render(<Host />);

    await waitFor(() => {
      expect(renderCounter).toHaveBeenCalled();
    });
    const rendersAfterMount = renderCounter.mock.calls.length;

    // Push 100 times through the feed's registered push function.
    act(() => {
      for (let i = 1; i <= 100; i++) {
        registeredPush?.(i);
      }
    });

    await waitFor(() => {
      expect(renderCounter.mock.calls.length).toBeGreaterThan(
        rendersAfterMount,
      );
    });

    // The decoupling promise: 100 pushes do NOT produce ~100 host
    // re-renders. Bounded by substrate commits, not by push count.
    const totalRenders = renderCounter.mock.calls.length;
    expect(totalRenders).toBeLessThan(20);
  });

  it("initial value flows through to the substrate's first commit", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = (): Worker => asWorker(fake);
    const subscribeFeed = (): (() => void) => () => {};

    const { result } = renderHook(() => {
      const source = useEventSource<{ v: number }>(subscribeFeed, { v: 42 });
      return useCoherentDerivation({
        streaming: source,
        compute: echoCompute,
        workerFactory: factory,
      });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ v: 42 });
    });
  });
});
