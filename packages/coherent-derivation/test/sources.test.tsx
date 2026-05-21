// @vitest-environment happy-dom

// `useCallbackSource` contract tests. The helper hook is the canonical
// adopter-facing path for high-rate streaming inputs; its contract is:
//
//   1. Returns a stable `[Source<T>, push]` tuple across re-renders.
//      Push function identity is referentially stable — safe to include
//      in adopter `useEffect` deps without causing re-subscription churn.
//   2. `getSnapshot()` returns the `initial` argument (or `undefined`
//      if omitted) until the first `push()` call.
//   3. After the first push, `getSnapshot()` returns the most recent
//      pushed value.
//   4. Listeners fire synchronously during `push()`.
//   5. Listener iteration uses a snapshot of the set, so a listener
//      that unsubscribes itself (or another) mid-notify is safe.
//   6. Unsubscribe is idempotent.
//   7. The returned `Source` is brand-protected — `isSource` returns
//      true; structural-shape spoofing without the brand fails.

import { act, render, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useCallbackSource, useEventSource } from "../src/sources.js";
import { isSource, type Source } from "../src/types.js";

describe("useCallbackSource — return tuple stability", () => {
  it("returns the same [source, push] tuple identities across re-renders", () => {
    const { result, rerender } = renderHook(() => useCallbackSource<number>(0));
    const [source1, push1] = result.current;
    rerender();
    const [source2, push2] = result.current;
    rerender();
    const [source3, push3] = result.current;
    expect(source2).toBe(source1);
    expect(source3).toBe(source1);
    expect(push2).toBe(push1);
    expect(push3).toBe(push1);
  });
});

describe("useCallbackSource — initial value", () => {
  it("getSnapshot returns the explicit initial before any push", () => {
    const { result } = renderHook(() => useCallbackSource<number>(42));
    const [source] = result.current;
    expect(source.getSnapshot()).toBe(42);
  });

  it("getSnapshot returns undefined when no initial supplied", () => {
    const { result } = renderHook(() =>
      useCallbackSource<number | undefined>(),
    );
    const [source] = result.current;
    expect(source.getSnapshot()).toBeUndefined();
  });

  it("getSnapshot returns the latest pushed value after a push", () => {
    const { result } = renderHook(() => useCallbackSource<number>(0));
    const [source, push] = result.current;
    act(() => push(1));
    expect(source.getSnapshot()).toBe(1);
    act(() => push(2));
    expect(source.getSnapshot()).toBe(2);
    act(() => push(99));
    expect(source.getSnapshot()).toBe(99);
  });
});

describe("useCallbackSource — subscribe / push notification", () => {
  it("fires subscribed listeners synchronously on push", () => {
    const { result } = renderHook(() => useCallbackSource<string>(""));
    const [source, push] = result.current;
    const listener = vi.fn();
    source.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
    push("hello");
    expect(listener).toHaveBeenCalledTimes(1);
    push("world");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("delivers to multiple subscribers", () => {
    const { result } = renderHook(() => useCallbackSource<number>(0));
    const [source, push] = result.current;
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    source.subscribe(a);
    source.subscribe(b);
    source.subscribe(c);
    push(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("does not call listeners that have unsubscribed", () => {
    const { result } = renderHook(() => useCallbackSource<number>(0));
    const [source, push] = result.current;
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    push(1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    push(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe is idempotent", () => {
    const { result } = renderHook(() => useCallbackSource<number>(0));
    const [source] = result.current;
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    expect(() => {
      unsubscribe();
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });
});

describe("useCallbackSource — mid-notify subscriber modifications", () => {
  it("listener that unsubscribes itself still fires for the current delivery; absent on the next", () => {
    const { result } = renderHook(() => useCallbackSource<number>(0));
    const [source, push] = result.current;
    const calls: string[] = [];
    let unsubA: (() => void) | undefined;
    unsubA = source.subscribe(() => {
      calls.push("a");
      unsubA?.();
    });
    source.subscribe(() => {
      calls.push("b");
    });

    push(1);
    // First push: both fire (a unsubscribed itself but was in the
    // snapshot, so it still delivered).
    expect(calls).toEqual(["a", "b"]);

    push(2);
    // Second push: only b fires.
    expect(calls).toEqual(["a", "b", "b"]);
  });

  it("listener that unsubscribes another listener — the other still fires for the current delivery", () => {
    const { result } = renderHook(() => useCallbackSource<number>(0));
    const [source, push] = result.current;
    const calls: string[] = [];
    let unsubB: (() => void) | undefined;
    source.subscribe(() => {
      calls.push("a");
      unsubB?.();
    });
    unsubB = source.subscribe(() => {
      calls.push("b");
    });

    push(1);
    // a fired first, unsubscribed b. b was in the snapshot, still
    // delivered. Order is insertion order (a, b).
    expect(calls).toEqual(["a", "b"]);

    push(2);
    // Only a remains.
    expect(calls).toEqual(["a", "b", "a"]);
  });

  it("listener subscribed mid-notify does NOT fire on the current delivery; starts on the next", () => {
    const { result } = renderHook(() => useCallbackSource<number>(0));
    const [source, push] = result.current;
    const calls: string[] = [];
    let lateSubscribed = false;
    source.subscribe(() => {
      calls.push("a");
      if (!lateSubscribed) {
        lateSubscribed = true;
        source.subscribe(() => {
          calls.push("late");
        });
      }
    });

    push(1);
    // Only the original listener fires for this delivery.
    expect(calls).toEqual(["a"]);

    push(2);
    // Late listener now in the set; fires.
    expect(calls).toEqual(["a", "a", "late"]);
  });
});

describe("useCallbackSource — Source brand", () => {
  it("isSource returns true for the returned Source", () => {
    const { result } = renderHook(() => useCallbackSource<number>(0));
    const [source] = result.current;
    expect(isSource(source)).toBe(true);
  });

  it("isSource returns false for a plain object with the same shape (no brand)", () => {
    // Cast through `unknown` because TypeScript's structural inference matches
    // the spoof against the `Source<T>` arm of the union and then objects to
    // the missing brand at the type level — the very property we're verifying
    // is enforced at runtime.
    const spoof = {
      subscribe: () => () => {},
      getSnapshot: () => 0,
    } as unknown as Source<number>;
    expect(isSource(spoof)).toBe(false);
  });

  it("isSource returns false for a primitive", () => {
    expect(isSource(42)).toBe(false);
    expect(isSource("hello")).toBe(false);
    expect(isSource(null)).toBe(false);
    expect(isSource(undefined)).toBe(false);
  });
});

describe("useEventSource — subscribe lifecycle", () => {
  it("calls subscribe once on mount", () => {
    const subscribe = vi.fn(() => () => {});
    renderHook(() => useEventSource<number>(subscribe));
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("calls unsubscribe on unmount", () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const { unmount } = renderHook(() => useEventSource<number>(subscribe));
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("re-subscribes when subscribe identity changes", () => {
    const unsubscribeA = vi.fn();
    const unsubscribeB = vi.fn();
    const subscribeA = (): (() => void) => unsubscribeA;
    const subscribeB = (): (() => void) => unsubscribeB;
    const { rerender } = renderHook(
      ({ s }: { s: () => () => void }) => useEventSource<number>(s),
      { initialProps: { s: subscribeA } },
    );
    expect(unsubscribeA).not.toHaveBeenCalled();
    rerender({ s: subscribeB });
    // Identity change → cleanup the old subscription, set up the new.
    expect(unsubscribeA).toHaveBeenCalledTimes(1);
    expect(unsubscribeB).not.toHaveBeenCalled();
  });

  it("does NOT re-subscribe across renders if subscribe identity is stable", () => {
    const stableSubscribe = (): (() => void) => () => {};
    const subscribeSpy = vi.fn(stableSubscribe);
    const { rerender } = renderHook(() => useEventSource<number>(subscribeSpy));
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    rerender();
    rerender();
    rerender();
    // Same subscribe identity → no re-subscription churn.
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("useEventSource — push delivers values to the returned Source", () => {
  it("push from inside subscribe updates getSnapshot synchronously", () => {
    let registeredPush: ((value: number) => void) | undefined;
    const subscribe = (push: (value: number) => void): (() => void) => {
      registeredPush = push;
      return () => {};
    };
    const { result } = renderHook(() => useEventSource<number>(subscribe, 0));
    // getSnapshot returns the initial value before any push.
    expect(result.current.getSnapshot()).toBe(0);
    act(() => {
      registeredPush?.(42);
    });
    expect(result.current.getSnapshot()).toBe(42);
  });

  it("notifies subscribers when push is called", () => {
    let registeredPush: ((value: number) => void) | undefined;
    const subscribe = (push: (value: number) => void): (() => void) => {
      registeredPush = push;
      return () => {};
    };
    const { result } = renderHook(() => useEventSource<number>(subscribe, 0));
    const listener = vi.fn();
    const unsub = result.current.subscribe(listener);
    act(() => {
      registeredPush?.(1);
    });
    expect(listener).toHaveBeenCalledTimes(1);
    act(() => {
      registeredPush?.(2);
    });
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
  });
});

describe("useEventSource — initial value semantics", () => {
  it("getSnapshot returns the initial value before any push", () => {
    const subscribe = (): (() => void) => () => {};
    const { result } = renderHook(() =>
      useEventSource<{ v: number }>(subscribe, { v: 7 }),
    );
    expect(result.current.getSnapshot()).toEqual({ v: 7 });
  });

  it("getSnapshot returns undefined when no initial is supplied (pre-push)", () => {
    const subscribe = (): (() => void) => () => {};
    const { result } = renderHook(() => useEventSource<number>(subscribe));
    // Before any push, getSnapshot returns undefined (cast through T).
    expect(result.current.getSnapshot()).toBeUndefined();
  });
});

describe("useEventSource — Strict Mode lifecycle", () => {
  it("double-mount nets one active subscription after settling", () => {
    let activeSubscriptions = 0;
    const subscribe = vi.fn(() => {
      activeSubscriptions += 1;
      return () => {
        activeSubscriptions -= 1;
      };
    });

    const Host = (): null => {
      useEventSource<number>(subscribe);
      return null;
    };

    const { unmount } = render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );

    // Strict Mode setup → cleanup → setup. Final state: exactly one
    // active subscription registered with the feed.
    expect(activeSubscriptions).toBe(1);
    unmount();
    expect(activeSubscriptions).toBe(0);
  });
});

describe("useEventSource — returns a brand-protected Source", () => {
  it("isSource recognises the returned Source", () => {
    const subscribe = (): (() => void) => () => {};
    const { result } = renderHook(() => useEventSource<number>(subscribe));
    expect(isSource(result.current)).toBe(true);
  });

  it("the same Source identity is returned across re-renders with stable subscribe", () => {
    // `subscribe` is declared OUTSIDE the renderHook callback so its
    // identity is stable across re-renders.
    const subscribe = (): (() => void) => () => {};
    const { result, rerender } = renderHook(() =>
      useEventSource<number>(subscribe),
    );
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });
});
