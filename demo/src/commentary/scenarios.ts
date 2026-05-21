// Scenario detector — pure classifier + a 2 s debouncing settler.
//
// `classifyScenario(snapshot)` is a pure decision tree returning one of
// six PLAYBOOK §Scenarios 0–5 ids. `createScenarioSettler()` wraps it
// in a closure-stateful debouncer; caller injects `nowMs`.
//
// Branch precedence (first match wins):
//
//   1. shockActive && tickHz >= 500 && expiries >= 80 → S5-pathological
//   2. shockActive                                    → S4-shock
//   3. lastIntentToggleAgoMs < 4_000                  → S2-intent-toggle
//   4. expiries >= 80 || tickHz >= 100                → S3-heavier
//   5. expiries <= 12                                 → S0-baseline
//   6. otherwise                                      → S1-canonical
//
// Shock wins because it's the demo's visceral moment. Intent dominates
// load (S2 before S3) so the substrate-parallel narration foregrounds
// when relevant; load is the steady-state fallthrough.
//
// **Caller must invoke `update()` regularly**, not just on state-change
// events. The S2 → S1 fallback fires only when the 4 s intent window
// elapses — the classifier is pure and can't observe time passing on
// its own. The hook's 5 Hz tick covers this; at worst the boundary is
// detected 200 ms late (invisible under the 2 s debounce).
//
// **Backward clocks**: if `nowMs` regresses, the settler refuses to
// decrement its deadline (returns the current transitioning state).
// Shouldn't happen — the hook ticks forward — but the alternative
// (unbounded extension of the transition window) would surprise
// readers.
//
// **Slice selector excluded.** `displayMaturityYears` is display-only;
// the substrate never sees it. Only `repairMode` counts as an intent
// input for S2 classification.

/**
 * Six discrete macro states corresponding to PLAYBOOK §Scenarios 0–5.
 * Single source of truth for the literal union; downstream modules
 * import this type rather than re-stringing.
 */
export type Scenario =
  | "S0-baseline"
  | "S1-canonical"
  | "S2-intent-toggle"
  | "S3-heavier"
  | "S4-shock"
  | "S5-pathological";

/**
 * Snapshot consumed by the classifier. Stays decoupled from `App.tsx`'s
 * larger state surface — the hook adapts.
 *
 * `lastIntentToggleAgoMs` is `Date.now() - lastIntentTs` (or `Infinity`
 * when no intent has been observed yet — the `< 4_000` branch handles
 * that cleanly).
 */
export interface AppSnapshot {
  readonly shockActive: boolean;
  readonly tickHz: number;
  readonly expiries: number;
  readonly lastIntentToggleAgoMs: number;
}

/**
 * - `settled` — classifier output has been stable ≥ `SCENARIO_DEBOUNCE_MS`.
 * - `transitioning` — output changed and is awaiting stability; `pending`
 *   is the candidate, `settledAtMs` is when it will promote.
 */
export type SettlerOutput =
  | { readonly type: "settled"; readonly scenario: Scenario }
  | {
      readonly type: "transitioning";
      readonly pending: Scenario;
      readonly settledAtMs: number;
    };

export interface ScenarioSettler {
  /**
   * Feed the next snapshot at wall-clock `nowMs`. Caller MUST invoke
   * `update` regularly even without state changes — the S2 → S1
   * fallback needs ticks to observe the intent window closing.
   */
  update(snapshot: AppSnapshot, nowMs: number): SettlerOutput;
}

/**
 * Debounce window for `ScenarioSettler`. Tuned at 2 s; may revise after
 * real-time playthrough polish reveals a pacing issue.
 */
export const SCENARIO_DEBOUNCE_MS = 2_000;

/**
 * Threshold for the S2-intent-toggle branch — an intent input that toggled
 * within the last `INTENT_RECENT_WINDOW_MS` keeps the classifier in S2.
 */
export const INTENT_RECENT_WINDOW_MS = 4_000;

const PATHOLOGICAL_TICK_HZ_MIN = 500;
const PATHOLOGICAL_EXPIRIES_MIN = 80;
const HEAVY_TICK_HZ_MIN = 100;
const HEAVY_EXPIRIES_MIN = 80;
const BASELINE_EXPIRIES_MAX = 12;

/**
 * Pure decision tree. Branch precedence in the module header; first
 * match wins. Total — every input maps to exactly one `Scenario`.
 */
export function classifyScenario(snapshot: AppSnapshot): Scenario {
  const { shockActive, tickHz, expiries, lastIntentToggleAgoMs } = snapshot;

  // S5: conjunction of all three is load-bearing — any condition alone
  // falls through to S4 / S3.
  if (
    shockActive &&
    tickHz >= PATHOLOGICAL_TICK_HZ_MIN &&
    expiries >= PATHOLOGICAL_EXPIRIES_MIN
  ) {
    return "S5-pathological";
  }

  if (shockActive) {
    return "S4-shock";
  }

  if (lastIntentToggleAgoMs < INTENT_RECENT_WINDOW_MS) {
    return "S2-intent-toggle";
  }

  // S3 before S0: a 12-expiry surface at 500 Hz still counts as heavy
  // (tick pressure makes it heavy).
  if (expiries >= HEAVY_EXPIRIES_MIN || tickHz >= HEAVY_TICK_HZ_MIN) {
    return "S3-heavier";
  }

  if (expiries <= BASELINE_EXPIRIES_MAX) {
    return "S0-baseline";
  }
  return "S1-canonical";
}

interface PendingState {
  readonly scenario: Scenario;
  /** `firstSeenMs + SCENARIO_DEBOUNCE_MS` = promote-to-settled deadline. */
  readonly firstSeenMs: number;
}

/**
 * State-machine summary:
 *
 *   - First call               → settle immediately as `current`.
 *   - Same classification      → settled (clear any pending).
 *   - New classification       → start pending, return transitioning.
 *   - Same pending repeats     → preserve original `firstSeenMs`.
 *   - New pending while pending → replace + restart the 2 s window.
 *   - Deadline elapsed         → promote pending → current.
 *   - Backward clock           → keep `firstSeenMs`; don't decrement.
 */
export function createScenarioSettler(): ScenarioSettler {
  let current: Scenario | null = null;
  let pending: PendingState | null = null;

  return {
    update(snapshot, nowMs) {
      const classified = classifyScenario(snapshot);

      // Bootstrap — no current yet. Settle immediately.
      if (current === null) {
        current = classified;
        return { type: "settled", scenario: current };
      }

      // Steady state — classification unchanged from current.
      if (classified === current) {
        // Reverting to current during a transition cancels the transition.
        pending = null;
        return { type: "settled", scenario: current };
      }

      // Pending: start fresh, or replace if the candidate switched.
      // Identical-pending preserves `firstSeenMs` so the clock doesn't
      // restart on every same-classification update.
      if (pending === null || pending.scenario !== classified) {
        pending = { scenario: classified, firstSeenMs: nowMs };
      }

      // Backward-clock defence: if `nowMs` regresses behind
      // `firstSeenMs`, anchor to the original — don't decrement the
      // deadline.
      const effectiveNow = Math.max(nowMs, pending.firstSeenMs);
      const settledAtMs = pending.firstSeenMs + SCENARIO_DEBOUNCE_MS;

      if (effectiveNow >= settledAtMs) {
        current = pending.scenario;
        pending = null;
        return { type: "settled", scenario: current };
      }

      return { type: "transitioning", pending: pending.scenario, settledAtMs };
    },
  };
}
