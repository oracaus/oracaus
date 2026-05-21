// @vitest-environment happy-dom

// Tests for the toast stack container. happy-dom + @testing-library/react
// cover rendering, positioning, layout, and the per-toast leaving
// signal. The leaving LIFECYCLE (when the hook flips a toast's
// `leaving` flag, and when it removes the toast from the array entirely)
// lives in `use-commentary.test.tsx` — Stack is a dumb renderer.

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Helper: flush one animation frame. The toast wrapper defers
// `setEntered(true)` via `requestAnimationFrame` so the browser paints
// the pre-entry state before the transition starts (Stage 11.x —
// fix-up for the entry-snap bug). Tests that observe the entered state
// need to advance fake timers past one frame.
async function flushFrame(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
}

import type { CommentaryToastInstance } from "../../src/components/CommentaryToast.js";
import { CommentaryToastStack } from "../../src/components/CommentaryToastStack.js";

let testInstanceCounter = 0;
function makeToast(
  id: string,
  text: string,
  tier: 1 | 2 | 3 | 4 | 5 = 4,
  overrides: Partial<CommentaryToastInstance> = {},
): CommentaryToastInstance {
  testInstanceCounter += 1;
  return {
    id,
    instanceId: `${id}#${testInstanceCounter}`,
    text,
    tier,
    dismissAtMs: 10_000,
    ...overrides,
  };
}

describe("CommentaryToastStack — rendering", () => {
  it("renders nothing when toasts is empty", () => {
    const { queryByTestId } = render(<CommentaryToastStack toasts={[]} />);
    expect(queryByTestId("commentary-toast-stack")).toBeNull();
  });

  it("renders a single toast", () => {
    const toasts = [makeToast("a", "First.")];
    const { queryAllByTestId } = render(
      <CommentaryToastStack toasts={toasts} />,
    );
    expect(queryAllByTestId("commentary-toast").length).toBe(1);
  });

  it("renders multiple toasts (capacity-of-2 enforced upstream by the hook)", () => {
    const toasts = [makeToast("a", "First."), makeToast("b", "Second.")];
    const { queryAllByTestId } = render(
      <CommentaryToastStack toasts={toasts} />,
    );
    expect(queryAllByTestId("commentary-toast").length).toBe(2);
  });

  it("renders two toasts with the same phrase `id` cleanly (React keys via `instanceId`)", () => {
    // Surgical cooldown-clear on cancelAll (Stage 7 §12) makes it
    // possible for two toasts with the same phrase id to land in the
    // stack within the 8 s tier-min lifetime — e.g., user clicks
    // tickHz, ack plays, user clicks tickHz again mid-playback. The
    // React key must be `instanceId` (per-push unique), not the
    // phrase id, or we'd see "Encountered two children with the same
    // key" warnings.
    const toasts = [
      makeToast("ack-tickHz-v1", "Tick rate now fifty per second.", 1),
      makeToast("ack-tickHz-v1", "Tick rate now one hundred per second.", 1),
    ];
    const { queryAllByTestId } = render(
      <CommentaryToastStack toasts={toasts} />,
    );
    expect(queryAllByTestId("commentary-toast").length).toBe(2);
    // Both phrase ids identical:
    expect(toasts[0]?.id).toBe(toasts[1]?.id);
    // But instanceIds differ → React reconciles cleanly.
    expect(toasts[0]?.instanceId).not.toBe(toasts[1]?.instanceId);
  });

  it("renders toasts in the order given (newest-at-top is the hook's responsibility)", () => {
    const toasts = [makeToast("a", "Newest."), makeToast("b", "Older.")];
    const { queryAllByTestId } = render(
      <CommentaryToastStack toasts={toasts} />,
    );
    const textNodes = queryAllByTestId("commentary-toast-text");
    expect(textNodes[0]?.textContent).toBe("Newest.");
    expect(textNodes[1]?.textContent).toBe("Older.");
  });
});

describe("CommentaryToastStack — positioning + interaction", () => {
  it("container is fixed-positioned, top-centred, z-50, with items centred horizontally", () => {
    const { getByTestId } = render(
      <CommentaryToastStack toasts={[makeToast("a", "x")]} />,
    );
    const stack = getByTestId("commentary-toast-stack");
    expect(stack.className).toContain("fixed");
    expect(stack.className).toContain("left-1/2");
    expect(stack.className).toContain("-translate-x-1/2");
    expect(stack.className).toContain("z-50");
    // `items-center` is load-bearing — each toast renders at its own
    // intrinsic width, not stretched to match the widest sibling.
    expect(stack.className).toContain("items-center");
  });

  it("container has `pointer-events: none` so cursor passes through to underlying content", () => {
    const { getByTestId } = render(
      <CommentaryToastStack toasts={[makeToast("a", "x")]} />,
    );
    expect(getByTestId("commentary-toast-stack").className).toContain(
      "pointer-events-none",
    );
  });

  it("top offset is 98px (just below toolbar with breathing room)", () => {
    const { getByTestId } = render(
      <CommentaryToastStack toasts={[makeToast("a", "x")]} />,
    );
    expect(getByTestId("commentary-toast-stack").style.top).toBe("98px");
  });
});

describe("CommentaryToastStack — entry animation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("initial render is in the pre-entry state (opacity-0 + -translate-y-full)", () => {
    // Two-frame entry: the toast mounts in the pre-entry state so the
    // browser paints it once at opacity-0 before the RAF-deferred
    // `setEntered(true)` triggers the CSS transition.
    const { getByTestId } = render(
      <CommentaryToastStack toasts={[makeToast("a", "x")]} />,
    );
    const wrapper = getByTestId("commentary-toast-wrapper");
    expect(wrapper.className).toContain("transition-[opacity,transform]");
    expect(wrapper.className).toContain("-translate-y-full");
    expect(wrapper.className).toContain("opacity-0");
  });

  it("after one animation frame the wrapper lands at the visible state (translate-y-0 + opacity-100)", async () => {
    // RAF callback fires after the first frame, flipping `entered=true`.
    // The CSS transition interpolates from the pre-entry frame to here.
    const { getByTestId } = render(
      <CommentaryToastStack toasts={[makeToast("a", "x")]} />,
    );
    await flushFrame();
    const wrapper = getByTestId("commentary-toast-wrapper");
    expect(wrapper.className).toContain("translate-y-0");
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.dataset.leaving).toBe("false");
  });
});

describe("CommentaryToastStack — exit animation (fade in place, no slide)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("toast with `leaving=true` renders the leaving classes (translate-y-0 + opacity-0)", async () => {
    // The hook flips `leaving=true` on the toast once dismissAtMs has
    // passed. The stack reads the flag and renders fade-out classes:
    // `translate-y-0` is preserved (no slide), `opacity-0` triggers the
    // fade. CSS transition interpolates from the visible state — which
    // requires waiting one frame for `entered=true` to settle first.
    const leavingToast = makeToast("a", "Fading.", 3, { leaving: true });
    const { getByTestId } = render(
      <CommentaryToastStack toasts={[leavingToast]} />,
    );
    await flushFrame();
    const wrapper = getByTestId("commentary-toast-wrapper");
    expect(wrapper.dataset.leaving).toBe("true");
    // Stays in-position (no slide-up on exit), but fades out.
    expect(wrapper.className).toContain("translate-y-0");
    expect(wrapper.className).toContain("opacity-0");
    // Transition still wired so the fade-out animates — explicit
    // compositor-only properties (opacity + transform).
    expect(wrapper.className).toContain("transition-[opacity,transform]");
  });

  it("toggling `leaving` between renders updates the className (drives CSS transition)", async () => {
    const toast = makeToast("a", "Visible then fading.", 3);
    const { getByTestId, rerender } = render(
      <CommentaryToastStack toasts={[toast]} />,
    );
    // After one frame the wrapper is in the entered state.
    await flushFrame();
    expect(getByTestId("commentary-toast-wrapper").className).toContain(
      "opacity-100",
    );

    // Hook flips leaving=true on the same toast (same id).
    rerender(<CommentaryToastStack toasts={[{ ...toast, leaving: true }]} />);
    expect(getByTestId("commentary-toast-wrapper").className).toContain(
      "opacity-0",
    );
    expect(getByTestId("commentary-toast-wrapper").dataset.leaving).toBe(
      "true",
    );
  });
});
