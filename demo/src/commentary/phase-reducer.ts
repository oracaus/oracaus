// Pure phase reducer. Same (state, event) → same next state; no timers,
// no localStorage, no async. Side effects flow through the hook's
// useEffect chain. Total — every (state, event) pair handled; default
// arms use `assertNever` so missed cases fail at compile time.
//
// Phase machine:
//
//     BOOT + INIT → INTRO
//
//     INTRO + INTRO_DONE         → OBSERVATION
//     INTRO + INTRO_INTERRUPTED  → OBSERVATION (intent cancels the script)
//     INTRO + TAB_HIDDEN         → PAUSED(prev=INTRO)
//
//     OBSERVATION + SCENARIO_SETTLED → OBSERVATION (updates scenarioInFlight)
//     OBSERVATION + TAB_HIDDEN       → PAUSED(prev=OBSERVATION)
//
//     PAUSED + TAB_VISIBLE → resume per prevPhase:
//       INTRO       → OBSERVATION (don't resume INTRO mid-flight)
//       OBSERVATION → OBSERVATION
//
// `enabled` (the toolbar play/pause state) is orthogonal to phase and
// lives in the hook's `useState`, not here. SCENARIO_SETTLED in
// non-OBSERVATION phases is a no-op so the settler tick can fire during
// INTRO without churning state.

import type { Scenario } from "./scenarios.js";

export type PhaseState =
  | { readonly phase: "BOOT" }
  | { readonly phase: "INTRO" }
  | {
      readonly phase: "OBSERVATION";
      readonly scenarioInFlight: Scenario | null;
    }
  | {
      readonly phase: "PAUSED";
      readonly prevPhase: ResumablePhase;
      readonly scenarioInFlight: Scenario | null;
    };

export type ResumablePhase = "INTRO" | "OBSERVATION";

export type PhaseEvent =
  | { readonly type: "INIT" }
  | { readonly type: "INTRO_DONE" }
  /** Intent (settings change or pause toggle) registered during INTRO. */
  | { readonly type: "INTRO_INTERRUPTED" }
  | { readonly type: "SCENARIO_SETTLED"; readonly scenario: Scenario }
  | { readonly type: "TAB_HIDDEN" }
  | { readonly type: "TAB_VISIBLE" };

export const INITIAL_PHASE_STATE: PhaseState = { phase: "BOOT" };

function assertNever(value: never): never {
  throw new Error(`unhandled phase reducer case: ${JSON.stringify(value)}`);
}

// Switch on event type first so cross-cutting events (TAB_HIDDEN /
// TAB_VISIBLE) get a single arm regardless of phase.
export function phaseReducer(state: PhaseState, event: PhaseEvent): PhaseState {
  switch (event.type) {
    case "INIT":
      if (state.phase !== "BOOT") return state;
      return { phase: "INTRO" };

    case "INTRO_DONE":
      if (state.phase !== "INTRO") return state;
      return { phase: "OBSERVATION", scenarioInFlight: null };

    case "INTRO_INTERRUPTED":
      if (state.phase !== "INTRO") return state;
      return { phase: "OBSERVATION", scenarioInFlight: null };

    case "SCENARIO_SETTLED": {
      if (state.phase !== "OBSERVATION") return state;
      // Idempotent — same scenario doesn't churn state.
      if (state.scenarioInFlight === event.scenario) return state;
      return { ...state, scenarioInFlight: event.scenario };
    }

    case "TAB_HIDDEN": {
      if (state.phase === "BOOT") return state;
      if (state.phase === "PAUSED") return state;
      const scenarioInFlight =
        state.phase === "OBSERVATION" ? state.scenarioInFlight : null;
      return {
        phase: "PAUSED",
        prevPhase: state.phase,
        scenarioInFlight,
      };
    }

    case "TAB_VISIBLE": {
      if (state.phase !== "PAUSED") return state;
      switch (state.prevPhase) {
        case "INTRO":
        case "OBSERVATION":
          // INTRO resumes to OBSERVATION (one-shot rule).
          return {
            phase: "OBSERVATION",
            scenarioInFlight: state.scenarioInFlight,
          };
        default:
          return assertNever(state.prevPhase);
      }
    }

    default:
      return assertNever(event);
  }
}
