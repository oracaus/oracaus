// Tests for `shouldEnqueueInsight` — Stage 11.6's polite-enqueue rule
// extracted as a pure function. Independent of React render lifecycle;
// each test sets a state shape and asserts the boolean outcome.

import { describe, expect, it } from "vitest";

import {
  INSIGHT_QUIET_WINDOW_MS,
  shouldEnqueueInsight,
} from "../../src/commentary/use-commentary.js";

const baseState = (
  overrides: Partial<Parameters<typeof shouldEnqueueInsight>[0]> = {},
) => ({
  phase: "OBSERVATION" as const,
  recordingMode: false,
  enabled: true,
  toastsLength: 0,
  queueDepth: 0,
  lastFireAtMs: Number.NEGATIVE_INFINITY,
  nowMs: 100_000,
  ...overrides,
});

describe("shouldEnqueueInsight — happy path", () => {
  it("passes when all four conditions are met", () => {
    expect(shouldEnqueueInsight(baseState())).toBe(true);
  });

  it("passes at exactly INSIGHT_QUIET_WINDOW_MS since last fire (boundary)", () => {
    expect(
      shouldEnqueueInsight(
        baseState({
          lastFireAtMs: 100_000 - INSIGHT_QUIET_WINDOW_MS,
          nowMs: 100_000,
        }),
      ),
    ).toBe(true);
  });
});

describe("shouldEnqueueInsight — phase / recording / enabled gates", () => {
  it("fails outside OBSERVATION (INTRO)", () => {
    expect(shouldEnqueueInsight(baseState({ phase: "INTRO" }))).toBe(false);
  });

  it("fails outside OBSERVATION (PAUSED)", () => {
    expect(shouldEnqueueInsight(baseState({ phase: "PAUSED" }))).toBe(false);
  });

  it("fails outside OBSERVATION (BOOT)", () => {
    expect(shouldEnqueueInsight(baseState({ phase: "BOOT" }))).toBe(false);
  });

  it("fails when recordingMode is true", () => {
    expect(shouldEnqueueInsight(baseState({ recordingMode: true }))).toBe(
      false,
    );
  });

  it("fails when commentary is disabled", () => {
    expect(shouldEnqueueInsight(baseState({ enabled: false }))).toBe(false);
  });
});

describe("shouldEnqueueInsight — quiet-state gates", () => {
  it("fails when a toast is currently visible", () => {
    expect(shouldEnqueueInsight(baseState({ toastsLength: 1 }))).toBe(false);
  });

  it("fails when the scheduler queue has pending inputs", () => {
    expect(shouldEnqueueInsight(baseState({ queueDepth: 1 }))).toBe(false);
  });

  it("fails when within INSIGHT_QUIET_WINDOW_MS of the last fire (1 ms short)", () => {
    expect(
      shouldEnqueueInsight(
        baseState({
          lastFireAtMs: 100_000 - INSIGHT_QUIET_WINDOW_MS + 1,
          nowMs: 100_000,
        }),
      ),
    ).toBe(false);
  });
});

describe("shouldEnqueueInsight — invariants", () => {
  it("any single failing condition is sufficient to drop", () => {
    // Drop on each gate independently.
    expect(shouldEnqueueInsight(baseState({ phase: "INTRO" }))).toBe(false);
    expect(shouldEnqueueInsight(baseState({ recordingMode: true }))).toBe(
      false,
    );
    expect(shouldEnqueueInsight(baseState({ enabled: false }))).toBe(false);
    expect(shouldEnqueueInsight(baseState({ toastsLength: 1 }))).toBe(false);
    expect(shouldEnqueueInsight(baseState({ queueDepth: 1 }))).toBe(false);
    expect(
      shouldEnqueueInsight(baseState({ lastFireAtMs: 99_500, nowMs: 100_000 })),
    ).toBe(false);
  });

  it("`-Infinity` lastFireAtMs always passes the 5 s window (first-fire sentinel)", () => {
    expect(
      shouldEnqueueInsight(
        baseState({ lastFireAtMs: Number.NEGATIVE_INFINITY, nowMs: 0 }),
      ),
    ).toBe(true);
  });
});
