// @vitest-environment happy-dom

import { act, render, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useCoherentDerivation } from "../src/use-coherent-derivation.js";
import { asWorker } from "./utils/as-worker.js";
import { FakeWorker } from "./utils/fake-worker.js";
import { streamingEchoRunner } from "./utils/runners.js";

// Stable references — tests must avoid creating fresh inputs/compute on
// every render or the React idiom of identity-based memoisation will trip.
// Generic so TS infers TOutput = TStreaming from the call site; otherwise
// `data` would type as `unknown` and per-field access in JSX like
// `data.v` / `data.msg` would fail to compile.
const echoCompute = async <T,>({
  streaming,
}: {
  streaming: T;
  intent: unknown;
}): Promise<T> => streaming;

describe("useCoherentDerivation — initial render", () => {
  it("returns the initial state shape on first render (before any compute)", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = () => asWorker(fake);
    const inputs = { x: 1 };
    const { result } = renderHook(() =>
      useCoherentDerivation({
        streaming: inputs,
        compute: echoCompute,
        workerFactory: factory,
      }),
    );

    // First render is synchronous; compute hasn't started yet (the setInputs
    // effect runs after commit). data is undefined at this point.
    expect(result.current.data).toBeUndefined();
    expect(result.current.dataSnapshotId).toBeUndefined();
    expect(typeof result.current.cancel).toBe("function");

    // Let post-commit effects settle so testing-library doesn't surface an
    // `act(...)` warning on teardown.
    await waitFor(() => {
      expect(result.current.isComputing).toBe(false);
    });
  });
});

describe("useCoherentDerivation — happy path", () => {
  it("commits data after the first compute resolves", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = () => asWorker(fake);
    const inputs = { value: 7 };
    const { result } = renderHook(() =>
      useCoherentDerivation({
        streaming: inputs,
        compute: echoCompute,
        workerFactory: factory,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ value: 7 });
    });
    expect(result.current.isComputing).toBe(false);
    expect(result.current.dataSnapshotId).toBeDefined();
  });

  it("recomputes when inputs change", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = () => asWorker(fake);
    const inputsA = { v: 1 };
    const inputsB = { v: 2 };
    const { result, rerender } = renderHook(
      ({ streaming }) =>
        useCoherentDerivation({
          streaming,
          compute: echoCompute,
          workerFactory: factory,
        }),
      { initialProps: { streaming: inputsA } },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ v: 1 });
    });

    rerender({ streaming: inputsB });
    await waitFor(() => {
      expect(result.current.data).toEqual({ v: 2 });
    });
  });
});

describe("useCoherentDerivation — Strict Mode double-mount", () => {
  it("destroys the first-mount strategy on cleanup; the second mount creates its own", async () => {
    const terminateCalls: number[] = [];
    let workerCount = 0;
    const factory = (): Worker => {
      const fake = new FakeWorker(streamingEchoRunner);
      const id = ++workerCount;
      const originalTerminate = fake.terminate.bind(fake);
      fake.terminate = () => {
        terminateCalls.push(id);
        originalTerminate();
      };
      return asWorker(fake);
    };
    const inputs = { v: 1 };

    const Component = (): React.ReactElement => {
      const { data } = useCoherentDerivation({
        streaming: inputs,
        compute: echoCompute,
        workerFactory: factory,
      });
      return (
        <div data-testid="strict-mode-display">
          {data ? `loaded:${data.v}` : "loading"}
        </div>
      );
    };

    const { getByTestId, unmount } = render(
      <StrictMode>
        <Component />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(getByTestId("strict-mode-display").textContent).toBe("loaded:1");
    });

    // Strict Mode in React 18+ double-invokes effects in dev: setup → cleanup
    // → setup. We expect at least one cleanup-driven terminate to have fired
    // before the final unmount. (workerCount is the number of strategies
    // created across the double-mount cycle.)
    expect(terminateCalls.length).toBeGreaterThanOrEqual(1);

    // Final unmount: every created strategy has now been destroyed.
    unmount();
    expect(terminateCalls.length).toBe(workerCount);
  });
});

describe("useCoherentDerivation — cancel()", () => {
  it("exposes a cancel function bound to the strategy", async () => {
    const fake = new FakeWorker(
      (inputs) =>
        new Promise<unknown>((resolve) => {
          setTimeout(() => resolve(inputs), 1000);
        }),
    );
    const factory = () => asWorker(fake);
    const inputs = "x";
    const { result } = renderHook(() =>
      useCoherentDerivation({
        streaming: inputs,
        compute: echoCompute,
        workerFactory: factory,
      }),
    );

    await waitFor(() => {
      expect(result.current.isComputing).toBe(true);
    });

    act(() => {
      result.current.cancel();
    });
    await waitFor(() => {
      expect(result.current.isComputing).toBe(false);
    });
  });
});

describe("useCoherentDerivation — unmount cleanup", () => {
  it("terminates the worker on unmount", () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const terminateSpy = vi.spyOn(fake, "terminate");
    const factory = () => asWorker(fake);
    const inputs = 1;
    const { unmount } = renderHook(() =>
      useCoherentDerivation({
        streaming: inputs,
        compute: echoCompute,
        workerFactory: factory,
      }),
    );

    unmount();
    expect(terminateSpy).toHaveBeenCalled();
  });
});

describe("useCoherentDerivation — render integration", () => {
  it("renders the data inside a component", async () => {
    const fake = new FakeWorker(streamingEchoRunner);
    const factory = () => asWorker(fake);
    const inputs = { msg: "hi" };
    const Display = (): React.ReactElement => {
      const { data, isComputing } = useCoherentDerivation({
        streaming: inputs,
        compute: echoCompute,
        workerFactory: factory,
      });
      return (
        <div data-testid="display">
          {isComputing ? "computing" : (data?.msg ?? "idle")}
        </div>
      );
    };

    const { getByTestId } = render(<Display />);
    await waitFor(() => {
      expect(getByTestId("display").textContent).toBe("hi");
    });
  });
});
