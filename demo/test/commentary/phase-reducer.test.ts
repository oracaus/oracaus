// Tests for the pure phase reducer. No React, no timers — `phaseReducer`
// is a deterministic function over (state, event); we exercise the full
// transition matrix as a table.

import { describe, expect, it } from "vitest";

import {
  INITIAL_PHASE_STATE,
  type PhaseState,
  phaseReducer,
} from "../../src/commentary/phase-reducer.js";

describe("phase reducer", () => {
  it("BOOT + INIT → INTRO", () => {
    expect(phaseReducer(INITIAL_PHASE_STATE, { type: "INIT" })).toEqual({
      phase: "INTRO",
    });
  });

  it("INIT is idempotent after BOOT — second INIT is a no-op", () => {
    const first = phaseReducer(INITIAL_PHASE_STATE, { type: "INIT" });
    expect(phaseReducer(first, { type: "INIT" })).toEqual(first);
  });

  it("INIT outside BOOT is a no-op (defensive)", () => {
    const obs: PhaseState = { phase: "OBSERVATION", scenarioInFlight: null };
    expect(phaseReducer(obs, { type: "INIT" })).toBe(obs);
  });

  it("INTRO + INTRO_DONE → OBSERVATION", () => {
    const intro: PhaseState = { phase: "INTRO" };
    expect(phaseReducer(intro, { type: "INTRO_DONE" })).toEqual({
      phase: "OBSERVATION",
      scenarioInFlight: null,
    });
  });

  it("INTRO_DONE outside INTRO is a no-op", () => {
    const obs: PhaseState = { phase: "OBSERVATION", scenarioInFlight: null };
    expect(phaseReducer(obs, { type: "INTRO_DONE" })).toBe(obs);
  });

  it("INTRO + INTRO_INTERRUPTED → OBSERVATION (intent cancels the script)", () => {
    const intro: PhaseState = { phase: "INTRO" };
    expect(phaseReducer(intro, { type: "INTRO_INTERRUPTED" })).toEqual({
      phase: "OBSERVATION",
      scenarioInFlight: null,
    });
  });

  it("INTRO_INTERRUPTED outside INTRO is a no-op (defensive)", () => {
    const obs: PhaseState = {
      phase: "OBSERVATION",
      scenarioInFlight: "S4-shock",
    };
    expect(phaseReducer(obs, { type: "INTRO_INTERRUPTED" })).toBe(obs);
    expect(
      phaseReducer(INITIAL_PHASE_STATE, { type: "INTRO_INTERRUPTED" }),
    ).toBe(INITIAL_PHASE_STATE);
  });

  it("OBSERVATION + SCENARIO_SETTLED → updates scenarioInFlight; idempotent on same scenario", () => {
    const obs: PhaseState = { phase: "OBSERVATION", scenarioInFlight: null };
    const next = phaseReducer(obs, {
      type: "SCENARIO_SETTLED",
      scenario: "S4-shock",
    });
    expect(next).toEqual({
      phase: "OBSERVATION",
      scenarioInFlight: "S4-shock",
    });
    expect(
      phaseReducer(next, { type: "SCENARIO_SETTLED", scenario: "S4-shock" }),
    ).toBe(next);
  });

  it("SCENARIO_SETTLED outside OBSERVATION is a no-op", () => {
    const intro: PhaseState = { phase: "INTRO" };
    expect(
      phaseReducer(intro, {
        type: "SCENARIO_SETTLED",
        scenario: "S1-canonical",
      }),
    ).toBe(intro);
  });

  it("OBSERVATION + TAB_HIDDEN → PAUSED preserves scenarioInFlight", () => {
    const obs: PhaseState = {
      phase: "OBSERVATION",
      scenarioInFlight: "S3-heavier",
    };
    expect(phaseReducer(obs, { type: "TAB_HIDDEN" })).toEqual({
      phase: "PAUSED",
      prevPhase: "OBSERVATION",
      scenarioInFlight: "S3-heavier",
    });
  });

  it("INTRO + TAB_HIDDEN → PAUSED(prev=INTRO)", () => {
    const intro: PhaseState = { phase: "INTRO" };
    expect(phaseReducer(intro, { type: "TAB_HIDDEN" })).toEqual({
      phase: "PAUSED",
      prevPhase: "INTRO",
      scenarioInFlight: null,
    });
  });

  it("PAUSED(prev=INTRO) + TAB_VISIBLE → OBSERVATION (don't resume INTRO mid-flight)", () => {
    const paused: PhaseState = {
      phase: "PAUSED",
      prevPhase: "INTRO",
      scenarioInFlight: null,
    };
    expect(phaseReducer(paused, { type: "TAB_VISIBLE" })).toEqual({
      phase: "OBSERVATION",
      scenarioInFlight: null,
    });
  });

  it("PAUSED(prev=OBSERVATION) + TAB_VISIBLE → OBSERVATION preserves scenarioInFlight", () => {
    const paused: PhaseState = {
      phase: "PAUSED",
      prevPhase: "OBSERVATION",
      scenarioInFlight: "S4-shock",
    };
    expect(phaseReducer(paused, { type: "TAB_VISIBLE" })).toEqual({
      phase: "OBSERVATION",
      scenarioInFlight: "S4-shock",
    });
  });

  it("TAB_VISIBLE outside PAUSED is a no-op", () => {
    const obs: PhaseState = { phase: "OBSERVATION", scenarioInFlight: null };
    expect(phaseReducer(obs, { type: "TAB_VISIBLE" })).toBe(obs);
  });

  it("TAB_HIDDEN from BOOT is a no-op (no UI to pause)", () => {
    expect(phaseReducer(INITIAL_PHASE_STATE, { type: "TAB_HIDDEN" })).toBe(
      INITIAL_PHASE_STATE,
    );
  });

  it("TAB_HIDDEN from PAUSED is a no-op (already paused)", () => {
    const paused: PhaseState = {
      phase: "PAUSED",
      prevPhase: "OBSERVATION",
      scenarioInFlight: null,
    };
    expect(phaseReducer(paused, { type: "TAB_HIDDEN" })).toBe(paused);
  });
});
