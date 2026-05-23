// @vitest-environment happy-dom

// Tests for the commentary orchestrator hook. happy-dom +
// @testing-library/react's renderHook cover the hook surface; the
// reducer is tested separately.
//
// Test pattern: the hook enters INTRO immediately on mount. Tests that
// want to exercise OBSERVATION behaviour use `toggleEnabled()` twice
// (off → on) via the `skipIntroVia` helper — pause dispatches
// INTRO_INTERRUPTED, phase routes to OBSERVATION, play re-enables. Same
// path a real user hits to skip the intro. Avoids advancing virtual
// time through the full INTRO sequence.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type UseCommentaryOptions,
  useCommentary,
} from "../../src/commentary/use-commentary.js";

const baseOptions = (
  overrides: Partial<UseCommentaryOptions> = {},
): UseCommentaryOptions => ({
  shockActive: false,
  tickHz: 50,
  expiries: 70,
  repairMode: "on",
  recordingMode: false,
  ...overrides,
});

/**
 * Test helper: skip INTRO instantly by toggling commentary off then back
 * on. Pause dispatches INTRO_INTERRUPTED → phase becomes OBSERVATION;
 * play re-enables the surface. Same user-driven path as a real user
 * skipping the intro.
 */
function skipIntroVia(result: { current: ReturnType<typeof useCommentary> }) {
  act(() => {
    result.current.toggleEnabled();
  });
  act(() => {
    result.current.toggleEnabled();
  });
}

describe("hook scaffolding", () => {
  it("imports cleanly and returns the locked result shape", () => {
    const { result } = renderHook(() => useCommentary(baseOptions()));
    expect(typeof result.current.toggleEnabled).toBe("function");
    expect(typeof result.current.enabled).toBe("boolean");
    expect(Array.isArray(result.current.toasts)).toBe(true);
  });

  it("re-renders without crashing", () => {
    const { rerender, result } = renderHook(() => useCommentary(baseOptions()));
    rerender();
    rerender();
    expect(result.current).toBeDefined();
  });
});

describe("bootstrap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enters INTRO immediately on mount with commentary enabled by default", async () => {
    const { result } = renderHook(() => useCommentary(baseOptions()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.phase).toBe("INTRO");
    expect(result.current.enabled).toBe(true);
  });

  it("recording mode also enters INTRO immediately + enabled=true", async () => {
    const { result } = renderHook(() =>
      useCommentary(baseOptions({ recordingMode: true })),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.phase).toBe("INTRO");
    expect(result.current.enabled).toBe(true);
  });
});

describe("toolbar toggle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("toggleEnabled flips the surface state", () => {
    const { result } = renderHook(() => useCommentary(baseOptions()));
    expect(result.current.enabled).toBe(true);

    act(() => {
      result.current.toggleEnabled();
    });
    expect(result.current.enabled).toBe(false);

    act(() => {
      result.current.toggleEnabled();
    });
    expect(result.current.enabled).toBe(true);
  });

  it("toggleEnabled is a no-op in recording mode", () => {
    const { result } = renderHook(() =>
      useCommentary(baseOptions({ recordingMode: true })),
    );
    expect(result.current.enabled).toBe(true);

    act(() => {
      result.current.toggleEnabled();
    });

    expect(result.current.enabled).toBe(true);
  });

  it("toggling commentary OFF mid-INTRO interrupts the phase + cancels the sequence", async () => {
    // Pause during INTRO dispatches INTRO_INTERRUPTED — phase routes
    // to OBSERVATION. A play-again-later doesn't replay INTRO from
    // phrase 1; INTRO is one-shot.
    const { result } = renderHook(() => useCommentary(baseOptions()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.phase).toBe("INTRO");
    expect(result.current.toasts.length).toBeGreaterThan(0);

    act(() => {
      result.current.toggleEnabled();
    });
    expect(result.current.enabled).toBe(false);
    expect(result.current.toasts.length).toBe(0);
    expect(result.current.phase).toBe("OBSERVATION");

    // Play again — INTRO must NOT replay.
    act(() => {
      result.current.toggleEnabled();
    });
    expect(result.current.enabled).toBe(true);
    expect(result.current.phase).toBe("OBSERVATION");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    const introToast = result.current.toasts.find((t) =>
      t.id.startsWith("intro-"),
    );
    expect(introToast).toBeUndefined();
  });
});

describe("OBSERVATION steady state + scenario-entry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the scenario-entry phrase on settle (S1 canonical)", async () => {
    const { result } = renderHook(() =>
      useCommentary(baseOptions({ settlerTickMs: 50 })),
    );
    skipIntroVia(result);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(result.current.phase).toBe("OBSERVATION");
    expect(result.current.toasts.at(-1)?.id).toBe("scenario-S1-canonical-v1");
  });

  it("scenario change updates the entry phrase (S1 → S4 on shock)", async () => {
    let shockActive = false;
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          shockActive,
        }),
      ),
    );
    skipIntroVia(result);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current.toasts.at(-1)?.id).toBe("scenario-S1-canonical-v1");

    shockActive = true;
    rerender();
    // ShockStart event (T1) preempts and plays first (~5.5s reading);
    // scenario-S4 settles on the 2s debounce + waits same-tier FIFO
    // for ShockStart to complete. Advance enough for scenario-S4 to
    // become the top toast.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(result.current.toasts.at(-1)?.id).toBe("scenario-S4-shock-v1");
    expect(result.current.toasts.at(-1)?.tier).toBe(1);
  });

  it("scenario-entry phrase id uses the namespace `scenario-{name}-v1`", async () => {
    const { result } = renderHook(() =>
      useCommentary(baseOptions({ settlerTickMs: 50 })),
    );
    skipIntroVia(result);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(result.current.toasts.at(-1)?.id).toMatch(
      /^scenario-S[0-9]-[a-z-]+-v1$/,
    );
  });

  it("toast dismissAtMs respects the tier-min lower bound (5000 ms above 'now' at push)", async () => {
    const { result } = renderHook(() =>
      useCommentary(baseOptions({ settlerTickMs: 50 })),
    );
    skipIntroVia(result);

    const tBefore = Date.now();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    const tAfter = Date.now();

    const toast = result.current.toasts.at(-1);
    expect(toast).toBeDefined();
    if (toast === undefined) throw new Error("expected a toast");
    expect(toast.tier).toBe(3);
    // S1-canonical phrase at tier 3: tier-min = 5000 ms;
    // reading-time + grace < 5000, so the tier-min wins. dismissAtMs
    // should be (push time) + 5000. Push time is between tBefore and
    // tAfter. Allow generous slack since test execution time can drift.
    expect(toast.dismissAtMs).toBeGreaterThanOrEqual(tBefore + 5_000);
    expect(toast.dismissAtMs).toBeLessThanOrEqual(tAfter + 5_000);
  });

  // Toast lifecycle (visible → leaving → removed) is covered by the
  // CommentaryToastStack component tests at the render layer. The
  // hook-level lifecycle test that previously verified the same
  // dismiss-tick mechanics relied on freezing `now`, which interacts
  // badly with the INTRO phrase-sequencer's pending setTimeout under
  // fake timers (blocks the test worker). The mechanics themselves are
  // exercised by both `toast dismissAtMs respects the tier-min` (push
  // timing) and the toast-component tests (leaving/removed transitions).

  it("unmount cleans up the settler-tick interval", async () => {
    const { result, unmount } = renderHook(() =>
      useCommentary(baseOptions({ settlerTickMs: 50 })),
    );
    skipIntroVia(result);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current.phase).toBe("OBSERVATION");

    expect(() => unmount()).not.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  });

  it("tab visibilitychange → hidden moves phase to PAUSED; visible restores OBSERVATION", async () => {
    const { result } = renderHook(() =>
      useCommentary(baseOptions({ settlerTickMs: 50 })),
    );
    skipIntroVia(result);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current.phase).toBe("OBSERVATION");

    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(result.current.phase).toBe("PAUSED");

    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(result.current.phase).toBe("OBSERVATION");
  });
});

describe("Stage 6 detector + Stage 7 scheduler wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ShockStart event preempts the Tier-4 scenario-entry toast", async () => {
    let shockActive = false;
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          shockActive,
          expiries: 12,
        }),
      ),
    );
    skipIntroVia(result);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current.toasts.at(-1)?.id).toBe("scenario-S0-baseline-v1");
    expect(result.current.toasts.at(-1)?.tier).toBe(4);

    shockActive = true;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.toasts.at(-1)?.id).toBe("event-ShockStart-v1");
    expect(result.current.toasts.at(-1)?.tier).toBe(1);
  });

  it("RepairFailed event surfaces as a toast", async () => {
    let surfaceArbStatus: "arb-free" | "repair-applied" | "repair-failed" =
      "arb-free";
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          surfaceArbStatus,
        }),
      ),
    );
    skipIntroVia(result);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    surfaceArbStatus = "repair-failed";
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.toasts.at(-1)?.id).toBe("event-RepairFailed-v1");
    expect(result.current.toasts.at(-1)?.tier).toBe(1);
  });
});

describe("Cancel-on-settings ack", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expiries change in OBSERVATION fires the ack toast 300 ms later", async () => {
    let expiries = 70;
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          expiries,
        }),
      ),
    );
    skipIntroVia(result);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expiries = 30;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });

    expect(result.current.toasts.at(-1)?.id).toBe("ack-expiries-v1");
    // Visual tier is 4 (muted/observation) — acks confirm a user
    // control change, not a critical alert. Scheduler priority is
    // still T1 for preempt; only the toast's visual presentation
    // is downgraded. See `visualTierFor` in use-commentary.ts.
    expect(result.current.toasts.at(-1)?.tier).toBe(4);
    expect(result.current.toasts.at(-1)?.text).toBe(
      "Surface now spans thirty expiries.",
    );
  });

  it("ack toast renders as T4 muted + uses T3's 5 s visibility floor (both decoupled from T1 scheduler priority)", async () => {
    let expiries = 70;
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          expiries,
        }),
      ),
    );
    skipIntroVia(result);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expiries = 30;
    rerender();
    const tBefore = Date.now();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    const tAfter = Date.now();

    const ack = result.current.toasts.at(-1);
    expect(ack?.id).toBe("ack-expiries-v1");
    // Visual tier is 4 (muted/observation) — see `visualTierFor`.
    // Scheduler priority remains T1 (for preempt semantics); only
    // the visible toast is downgraded.
    expect(ack?.tier).toBe(4);
    // Visibility floor is T3 (5000 ms) not T1 (8000 ms). The ack is
    // pushed somewhere inside the 450 ms window after a 300 ms debounce,
    // so dismissAtMs ≈ pushTime + 5000.
    expect(ack?.dismissAtMs).toBeGreaterThanOrEqual(tBefore + 5_000);
    expect(ack?.dismissAtMs).toBeLessThan(tBefore + 6_000);
    // Counter-check: would be ≥ tAfter + 7_000 under the T1 8000 floor.
    expect(ack?.dismissAtMs).toBeLessThan(tAfter + 6_000);
  });

  it("settings change DURING INTRO interrupts the script + fires the ack 300 ms later", async () => {
    let expiries = 70;
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          expiries,
        }),
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.phase).toBe("INTRO");

    expiries = 30;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.phase).toBe("OBSERVATION");
    expect(result.current.toasts.at(-1)?.id).toBe("ack-expiries-v1");
    expect(result.current.toasts.at(-1)?.text).toBe(
      "Surface now spans thirty expiries.",
    );
  });

  it("shock DURING INTRO interrupts the script + synthesises ShockStart", async () => {
    // OBSERVATION-tick's detector is dormant during INTRO. A shock
    // click before INTRO ends would otherwise produce zero shock
    // narration (no edge from undefined → true on detector bootstrap).
    // The shock-edge effect catches the rising edge and synthesises
    // ShockStart directly into the scheduler.
    let shockActive = false;
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          shockActive,
        }),
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.phase).toBe("INTRO");

    shockActive = true;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(result.current.phase).toBe("OBSERVATION");
    expect(result.current.toasts.at(-1)?.id).toMatch(/^event-ShockStart-v\d+$/);
    expect(result.current.toasts.at(-1)?.tier).toBe(1);
  });

  it("shock during INTRO is a no-op in recording mode (canonical take protected)", async () => {
    let shockActive = false;
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          recordingMode: true,
          shockActive,
        }),
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.phase).toBe("INTRO");

    shockActive = true;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // Recording-mode INTRO is uninterruptable — phase stays INTRO; no
    // ShockStart toast.
    expect(result.current.phase).toBe("INTRO");
    const shockToast = result.current.toasts.find((t) =>
      t.id.startsWith("event-ShockStart-"),
    );
    expect(shockToast).toBeUndefined();
  });

  it("rapid multi-click within debounce window emits exactly ONE ack for the FINAL value", async () => {
    let expiries = 70;
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          expiries,
        }),
      ),
    );
    skipIntroVia(result);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expiries = 50;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expiries = 30;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expiries = 12;
    rerender();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });

    expect(result.current.toasts.at(-1)?.id).toBe("ack-expiries-v1");
    expect(result.current.toasts.at(-1)?.text).toBe(
      "Surface now spans twelve expiries.",
    );

    const ackToasts = result.current.toasts.filter((t) =>
      t.id.startsWith("ack-"),
    );
    expect(ackToasts.length).toBe(1);
  });

  it("settings change while commentary is toggled OFF does NOT fire an ack", async () => {
    let expiries = 70;
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          expiries,
        }),
      ),
    );
    // Pause once → phase becomes OBSERVATION + enabled=false.
    act(() => {
      result.current.toggleEnabled();
    });
    expect(result.current.enabled).toBe(false);
    expect(result.current.phase).toBe("OBSERVATION");

    expiries = 30;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });

    expect(result.current.toasts.length).toBe(0);
  });

  it("pending debounce timer is cleared on phase transition out of OBSERVATION", async () => {
    let expiries = 70;
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          expiries,
        }),
      ),
    );
    skipIntroVia(result);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current.phase).toBe("OBSERVATION");

    expiries = 30;
    rerender();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.phase).toBe("PAUSED");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.phase).toBe("OBSERVATION");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const ackToasts = result.current.toasts.filter((t) =>
      t.id.startsWith("ack-"),
    );
    expect(ackToasts.length).toBe(0);
  });

  it("settings change in recording mode does NOT fire an ack (canonical-take protection)", async () => {
    let expiries = 70;
    const { result, rerender } = renderHook(() =>
      useCommentary(
        baseOptions({
          settlerTickMs: 50,
          recordingMode: true,
          expiries,
        }),
      ),
    );

    // Recording mode INTRO is uninterruptable — we can't use the toggle
    // trick. Allow the INTRO to settle naturally for a brief window so
    // the test verifies the ack-suppression in INTRO (which is also
    // covered by the recording-mode guard).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.phase).toBe("INTRO");

    expiries = 30;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });

    // Recording-mode guard suppresses the ack; phase stays INTRO.
    expect(result.current.phase).toBe("INTRO");
    const ackToasts = result.current.toasts.filter((t) =>
      t.id.startsWith("ack-"),
    );
    expect(ackToasts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------
// Stage 11.1 — pointer-aware region tracking (plumbing only)
// ---------------------------------------------------------------------

describe("hoveredRegion option (11.1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts hoveredRegion option without affecting hook behaviour", () => {
    // 11.1 lands the option as plumbing; the debouncer + commit +
    // polite-enqueue pipeline arrives in 11.2 / 11.6. Until then the
    // option is accepted but causes no observable effect — no commits,
    // no insight phrases.
    const { result, rerender } = renderHook(
      ({ hoveredRegion }: { hoveredRegion: "naive-panel" | null }) =>
        useCommentary(baseOptions({ hoveredRegion })),
      {
        initialProps: { hoveredRegion: null as "naive-panel" | null },
      },
    );

    expect(result.current.phase).toBe("INTRO");
    const baselineToastCount = result.current.toasts.length;

    rerender({ hoveredRegion: "naive-panel" });
    expect(result.current.phase).toBe("INTRO");
    expect(result.current.toasts.length).toBe(baselineToastCount);

    rerender({ hoveredRegion: null });
    expect(result.current.phase).toBe("INTRO");
    expect(result.current.toasts.length).toBe(baselineToastCount);
  });

  it("accepts every RegionId literal", async () => {
    const { REGION_IDS } = await import("../../src/commentary/region.js");
    expect(REGION_IDS).toContain("toolbar");
    expect(REGION_IDS).toContain("naive-panel");
    expect(REGION_IDS).toContain("gated-panel");
    expect(REGION_IDS).toContain("chain-table");
    expect(REGION_IDS).toContain("mismark-sparkline");
    expect(REGION_IDS.length).toBe(5);

    for (const region of REGION_IDS) {
      const { result, unmount } = renderHook(() =>
        useCommentary(baseOptions({ hoveredRegion: region })),
      );
      expect(result.current.phase).toBe("INTRO");
      unmount();
    }
  });
});

// ---------------------------------------------------------------------
// Stage 11.5 — committedRegion exposed on hook return
// ---------------------------------------------------------------------

describe("committedRegion on hook return (11.5)", () => {
  it("is present on the result shape, defaults to null at boot", () => {
    const { result } = renderHook(() => useCommentary(baseOptions()));
    expect(result.current).toHaveProperty("committedRegion");
    expect(result.current.committedRegion).toBeNull();
  });

  it("stays null during INTRO even when hoveredRegion is set (settler runs only in OBSERVATION)", () => {
    const { result, rerender } = renderHook(
      ({ hoveredRegion }: { hoveredRegion: "naive-panel" | null }) =>
        useCommentary(baseOptions({ hoveredRegion })),
      { initialProps: { hoveredRegion: null as "naive-panel" | null } },
    );
    expect(result.current.committedRegion).toBeNull();
    rerender({ hoveredRegion: "naive-panel" });
    // During INTRO the settler is not driven; no commits.
    expect(result.current.phase).toBe("INTRO");
    expect(result.current.committedRegion).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Stage 11.6 — region settler wired in OBSERVATION tick + polite-enqueue
// ---------------------------------------------------------------------

describe("region settler integration in OBSERVATION (11.6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits a region after ≥1.5 s of stable hover in OBSERVATION", async () => {
    const { result, rerender } = renderHook(
      ({ hoveredRegion }: { hoveredRegion: "naive-panel" | null }) =>
        useCommentary(baseOptions({ settlerTickMs: 50, hoveredRegion })),
      { initialProps: { hoveredRegion: null as "naive-panel" | null } },
    );
    skipIntroVia(result);
    expect(result.current.phase).toBe("OBSERVATION");

    // Pre-hover: no commit.
    expect(result.current.committedRegion).toBeNull();

    rerender({ hoveredRegion: "naive-panel" });
    // Brief hover (< 1.5 s) — still no commit.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.committedRegion).toBeNull();

    // Past 1.5 s dwell — commit fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(result.current.committedRegion).toBe("naive-panel");
  });

  it("clears committed after leaving + exit grace elapses", async () => {
    const { result, rerender } = renderHook(
      ({ hoveredRegion }: { hoveredRegion: "naive-panel" | null }) =>
        useCommentary(baseOptions({ settlerTickMs: 50, hoveredRegion })),
      { initialProps: { hoveredRegion: null as "naive-panel" | null } },
    );
    skipIntroVia(result);

    rerender({ hoveredRegion: "naive-panel" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_700);
    });
    expect(result.current.committedRegion).toBe("naive-panel");

    rerender({ hoveredRegion: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600); // > 500 ms exit grace
    });
    expect(result.current.committedRegion).toBeNull();
  });

  it("OBSERVATION → toggled-off transition clears the commit (settler reset)", async () => {
    const { result, rerender } = renderHook(
      ({ hoveredRegion }: { hoveredRegion: "naive-panel" | null }) =>
        useCommentary(baseOptions({ settlerTickMs: 50, hoveredRegion })),
      { initialProps: { hoveredRegion: null as "naive-panel" | null } },
    );
    skipIntroVia(result);
    rerender({ hoveredRegion: "naive-panel" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_700);
    });
    expect(result.current.committedRegion).toBe("naive-panel");

    // Toggle commentary off — committedRegion clears, settler resets.
    act(() => {
      result.current.toggleEnabled();
    });
    expect(result.current.committedRegion).toBeNull();
  });

  it("fires a region-insight toast after dwell when the system is quiet (polite-enqueue passes)", async () => {
    const { result, rerender } = renderHook(
      ({ hoveredRegion }: { hoveredRegion: "naive-panel" | null }) =>
        useCommentary(baseOptions({ settlerTickMs: 50, hoveredRegion })),
      { initialProps: { hoveredRegion: null as "naive-panel" | null } },
    );
    skipIntroVia(result);

    // Let the polite-enqueue 5 s quiet window pass since the
    // (potentially) just-fired toggleEnabled chain.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    rerender({ hoveredRegion: "naive-panel" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_700); // > 1.5 s dwell
    });
    // commit fired; polite-enqueue should have queued the insight.
    // The scheduler then plays it on the next tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const insightToast = result.current.toasts.find((t) =>
      t.id.startsWith("region-naive-panel-"),
    );
    expect(insightToast).toBeDefined();
  });

  it("recording mode suppresses pointer-driven insights even on commit (11.7 guard)", async () => {
    // The recording-mode guard lives in `shouldEnqueueInsight` and is
    // unit-tested directly in should-enqueue-insight.test.ts. This
    // integration test verifies the end-to-end behaviour: the hook,
    // running in recording mode, advances naturally through INTRO,
    // reaches OBSERVATION, observes a hover commit, and DOES NOT
    // produce a region-insight toast. The user is silenced for
    // pointer input; the Stage 12 driver retains its escape hatch
    // via direct scheduler.enqueue (not through this pipeline).
    //
    // skipIntroVia uses toggleEnabled, which is a no-op in recording
    // mode — so we advance fake timers through INTRO (~28 s of
    // reading + gaps) to reach OBSERVATION naturally.
    const { result, rerender } = renderHook(
      ({ hoveredRegion }: { hoveredRegion: "naive-panel" | null }) =>
        useCommentary(
          baseOptions({
            settlerTickMs: 50,
            hoveredRegion,
            recordingMode: true,
          }),
        ),
      { initialProps: { hoveredRegion: null as "naive-panel" | null } },
    );

    expect(result.current.phase).toBe("INTRO");

    // Advance through the full INTRO sequence. Five phrases at 140 wpm
    // with 600 ms gaps between (last has zero gap) → ~28 s. 35 s is
    // comfortable margin.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(result.current.phase).toBe("OBSERVATION");

    // Pre-hover baseline — no committed region, no region toast.
    expect(result.current.committedRegion).toBeNull();
    expect(
      result.current.toasts.find((t) => t.id.startsWith("region-")),
    ).toBeUndefined();

    // Start hovering naive-panel; advance past the 1.5 s dwell.
    rerender({ hoveredRegion: "naive-panel" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    // Settler committed — but the polite-enqueue check dropped the
    // input because `recordingMode === true`. No region-insight toast
    // surfaces.
    expect(result.current.committedRegion).toBe("naive-panel");
    expect(
      result.current.toasts.find((t) => t.id.startsWith("region-")),
    ).toBeUndefined();
  });
});
