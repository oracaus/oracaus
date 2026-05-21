// Tests for the Stage 4 scenario detector. Two-layer split: pure
// `classifyScenario` (table-driven) + `ScenarioSettler` (virtual clock).
//
// Test layout mirrors the implementation: classifier tests first (boundary +
// precedence), then settler tests (state machine + edge cases), then an
// omnibus PLAYBOOK walkthrough.

import { describe, expect, it } from "vitest";

import {
  type AppSnapshot,
  classifyScenario,
  createScenarioSettler,
  INTENT_RECENT_WINDOW_MS,
  SCENARIO_DEBOUNCE_MS,
  type Scenario,
  type SettlerOutput,
} from "../../src/commentary/scenarios.js";

// Reusable canonical baselines so each test calls out only the fields it
// flips — keeps the diff-from-default semantics readable.
const CANONICAL: AppSnapshot = {
  shockActive: false,
  tickHz: 50,
  expiries: 70,
  lastIntentToggleAgoMs: Number.POSITIVE_INFINITY,
};

describe("Stage 4 — scaffolding (4.1)", () => {
  it("exports the locked debounce window + intent-recent constants", () => {
    expect(SCENARIO_DEBOUNCE_MS).toBe(2_000);
    expect(INTENT_RECENT_WINDOW_MS).toBe(4_000);
  });

  it("createScenarioSettler() returns an object with an update method that yields an output", () => {
    const settler = createScenarioSettler();
    const out = settler.update(CANONICAL, 0);
    // First call must settle immediately (no previous classification to
    // debounce against). Asserting only the discriminator here — full
    // bootstrap semantics live in the settler-behaviour describe block.
    expect(out.type).toBe("settled");
  });
});

describe("Stage 4 — classifyScenario decision tree (4.2)", () => {
  it("S0-baseline — light surface, moderate tick, no shock, no recent intent", () => {
    // `expiries: 12` is the production minimum (the control surface's
    // smallest selectable count); also the upper bound on the
    // `BASELINE_EXPIRIES_MAX` branch — proves the branch hits at exactly
    // that value, not just below it.
    expect(
      classifyScenario({ ...CANONICAL, expiries: 12, tickHz: 50 }),
    ).toBe<Scenario>("S0-baseline");
  });

  it("S1-canonical — production-realistic default settings", () => {
    expect(classifyScenario(CANONICAL)).toBe<Scenario>("S1-canonical");
  });

  it("S2-intent-toggle — recent intent toggle fires regardless of expiries/tickHz at baseline", () => {
    expect(
      classifyScenario({ ...CANONICAL, lastIntentToggleAgoMs: 100 }),
    ).toBe<Scenario>("S2-intent-toggle");
  });

  it("S3-heavier — heavier surface boundary at expiries=80", () => {
    expect(classifyScenario({ ...CANONICAL, expiries: 80 })).toBe<Scenario>(
      "S3-heavier",
    );
  });

  it("S3-heavier — heavier surface boundary at tickHz=100", () => {
    expect(classifyScenario({ ...CANONICAL, tickHz: 100 })).toBe<Scenario>(
      "S3-heavier",
    );
  });

  it("S4-shock — shock active dominates classification", () => {
    expect(
      classifyScenario({ ...CANONICAL, shockActive: true }),
    ).toBe<Scenario>("S4-shock");
  });

  it("S5-pathological — requires BOTH tickHz>=500 AND expiries>=80 AND shock", () => {
    expect(
      classifyScenario({
        ...CANONICAL,
        shockActive: true,
        tickHz: 500,
        expiries: 80,
      }),
    ).toBe<Scenario>("S5-pathological");
  });

  it("S5 partial — shock + 500 Hz + 70 expiries falls through to S4 (not S5)", () => {
    expect(
      classifyScenario({
        ...CANONICAL,
        shockActive: true,
        tickHz: 500,
        expiries: 70,
      }),
    ).toBe<Scenario>("S4-shock");
  });

  it("S5 partial — shock + 200 Hz + 80 expiries falls through to S4 (not S5)", () => {
    expect(
      classifyScenario({
        ...CANONICAL,
        shockActive: true,
        tickHz: 200,
        expiries: 80,
      }),
    ).toBe<Scenario>("S4-shock");
  });

  it("S2 boundary — lastIntentToggleAgoMs=3999 still triggers S2; 4000 falls through", () => {
    expect(
      classifyScenario({ ...CANONICAL, lastIntentToggleAgoMs: 3999 }),
    ).toBe<Scenario>("S2-intent-toggle");
    expect(
      classifyScenario({ ...CANONICAL, lastIntentToggleAgoMs: 4000 }),
    ).toBe<Scenario>("S1-canonical");
  });
});

describe("Stage 4 — branch precedence (4.3)", () => {
  it("shock dominates intent: shockActive + recent intent → S4 (not S2)", () => {
    expect(
      classifyScenario({
        ...CANONICAL,
        shockActive: true,
        lastIntentToggleAgoMs: 100,
      }),
    ).toBe<Scenario>("S4-shock");
  });

  it("shock dominates heavy load: shockActive + heavy surface → S4 (not S3)", () => {
    expect(
      classifyScenario({
        ...CANONICAL,
        shockActive: true,
        expiries: 80,
        tickHz: 200,
      }),
    ).toBe<Scenario>("S4-shock");
  });

  it("intent dominates heavy load: heavy surface + recent intent → S2 (not S3)", () => {
    expect(
      classifyScenario({
        ...CANONICAL,
        expiries: 80,
        lastIntentToggleAgoMs: 500,
      }),
    ).toBe<Scenario>("S2-intent-toggle");
  });

  it("heavy-load wins over baseline: 80 expiries at 50 Hz → S3 (not S0); 12 expiries at 200 Hz → S3 (not S0)", () => {
    expect(
      classifyScenario({ ...CANONICAL, expiries: 80, tickHz: 50 }),
    ).toBe<Scenario>("S3-heavier");
    expect(
      classifyScenario({ ...CANONICAL, expiries: 12, tickHz: 200 }),
    ).toBe<Scenario>("S3-heavier");
  });

  it("canonical fall-through: 70 expiries at 50 Hz with no shock + no intent → S1", () => {
    expect(classifyScenario(CANONICAL)).toBe<Scenario>("S1-canonical");
  });
});

// Snapshots used by the settler tests. The settler doesn't care what
// classification a snapshot maps to — only whether two snapshots classify
// the same. We use three known-distinct classifications (S1 / S3 / S4) to
// exercise the state machine; the PLAYBOOK walkthrough below covers S0
// and S5 in their realistic settings.
const SNAP_S1: AppSnapshot = CANONICAL;
const SNAP_S3: AppSnapshot = { ...CANONICAL, expiries: 80 };
const SNAP_S4: AppSnapshot = { ...CANONICAL, shockActive: true };

/**
 * Narrow `SettlerOutput` to the transitioning variant for direct field
 * access. Throws if the output isn't transitioning — keeps test
 * assertions terse without losing type safety.
 */
function asTransitioning(
  out: SettlerOutput,
): Extract<SettlerOutput, { type: "transitioning" }> {
  if (out.type !== "transitioning") {
    throw new Error(`expected transitioning, got ${out.type}`);
  }
  return out;
}

describe("Stage 4 — ScenarioSettler state machine (4.4)", () => {
  it("bootstrap — first call settles immediately to the classified value", () => {
    const settler = createScenarioSettler();
    expect(settler.update(SNAP_S1, 0)).toEqual({
      type: "settled",
      scenario: "S1-canonical",
    });
  });

  it("settle-to-settle — identical snapshot keeps the settled state", () => {
    const settler = createScenarioSettler();
    settler.update(SNAP_S1, 0);
    expect(settler.update(SNAP_S1, 100)).toEqual({
      type: "settled",
      scenario: "S1-canonical",
    });
  });

  it("transition then settle — different classification + 2 s of stability promotes", () => {
    const settler = createScenarioSettler();
    settler.update(SNAP_S1, 0);

    const t1 = settler.update(SNAP_S3, 500);
    expect(asTransitioning(t1)).toEqual({
      type: "transitioning",
      pending: "S3-heavier",
      settledAtMs: 500 + SCENARIO_DEBOUNCE_MS,
    });

    // Just before deadline — still transitioning.
    expect(settler.update(SNAP_S3, 2499).type).toBe("transitioning");

    // At the deadline — promote.
    expect(settler.update(SNAP_S3, 2500)).toEqual({
      type: "settled",
      scenario: "S3-heavier",
    });
  });

  it("transient revert — A → B (transitioning) → A cancels pending; emits settled(A) immediately", () => {
    const settler = createScenarioSettler();
    settler.update(SNAP_S1, 0);
    expect(settler.update(SNAP_S3, 500).type).toBe("transitioning");
    expect(settler.update(SNAP_S1, 600)).toEqual({
      type: "settled",
      scenario: "S1-canonical",
    });
  });

  it("identical-pending re-classification preserves firstSeenMs (deadline doesn't slip)", () => {
    const settler = createScenarioSettler();
    settler.update(SNAP_S1, 0);
    const first = asTransitioning(settler.update(SNAP_S3, 500));
    // Re-classify to the same pending 200 ms later.
    const second = asTransitioning(settler.update(SNAP_S3, 700));
    expect(second.settledAtMs).toBe(first.settledAtMs);
    expect(second.pending).toBe("S3-heavier");
  });

  it("nested flip A → B → C — pending replaced, 2 s window restarts on the new candidate", () => {
    const settler = createScenarioSettler();
    settler.update(SNAP_S1, 0);
    asTransitioning(settler.update(SNAP_S3, 500)); // pending: S3, settledAt: 2500
    const flipped = asTransitioning(settler.update(SNAP_S4, 1000));
    expect(flipped.pending).toBe("S4-shock");
    expect(flipped.settledAtMs).toBe(1000 + SCENARIO_DEBOUNCE_MS); // new deadline

    // C settles at its own deadline (1000 + 2000 = 3000), not the
    // earlier B-deadline (2500).
    expect(settler.update(SNAP_S4, 2500).type).toBe("transitioning");
    expect(settler.update(SNAP_S4, 3000)).toEqual({
      type: "settled",
      scenario: "S4-shock",
    });
  });

  it("steady-state stability — 10 identical settled updates produce no churn", () => {
    const settler = createScenarioSettler();
    settler.update(SNAP_S1, 0);
    for (let i = 1; i <= 10; i += 1) {
      const out = settler.update(SNAP_S1, i * 1000);
      expect(out.type).toBe("settled");
      if (out.type === "settled") {
        expect(out.scenario).toBe("S1-canonical");
      }
    }
  });

  it("backward clock — nowMs regressing during transition does not decrement the deadline", () => {
    const settler = createScenarioSettler();
    settler.update(SNAP_S1, 2000);
    const first = asTransitioning(settler.update(SNAP_S3, 2500));
    expect(first.settledAtMs).toBe(2500 + SCENARIO_DEBOUNCE_MS); // 4500

    // nowMs goes backwards — defensive no-op.
    const second = asTransitioning(settler.update(SNAP_S3, 2000));
    expect(second.settledAtMs).toBe(4500); // unchanged
  });

  it("deadline is inclusive — nowMs === firstSeenMs + DEBOUNCE promotes", () => {
    const settler = createScenarioSettler();
    settler.update(SNAP_S1, 0);
    settler.update(SNAP_S3, 1000);
    expect(settler.update(SNAP_S3, 1000 + SCENARIO_DEBOUNCE_MS)).toEqual({
      type: "settled",
      scenario: "S3-heavier",
    });
  });

  it("settled → transition → settled round-trip — second transition restarts from new settled state", () => {
    const settler = createScenarioSettler();
    settler.update(SNAP_S1, 0); // settled S1
    settler.update(SNAP_S3, 100);
    settler.update(SNAP_S3, 2100); // settled S3 (100 + 2000)

    // Transition back to S1 — should re-debounce, not collapse.
    const back = asTransitioning(settler.update(SNAP_S1, 3000));
    expect(back.pending).toBe("S1-canonical");
    expect(back.settledAtMs).toBe(3000 + SCENARIO_DEBOUNCE_MS);
    expect(settler.update(SNAP_S1, 5000)).toEqual({
      type: "settled",
      scenario: "S1-canonical",
    });
  });
});

describe("Stage 4 — defensive edge cases (4.5)", () => {
  it("negative lastIntentToggleAgoMs — caller error treated as 'just fired' → S2", () => {
    // Defensive: negative implies the caller's clock math wrapped or
    // miscalculated. Classifier reads it as recent (< 4_000), erring on
    // the side of S2 narration rather than silently swallowing the bug.
    expect(
      classifyScenario({ ...CANONICAL, lastIntentToggleAgoMs: -100 }),
    ).toBe<Scenario>("S2-intent-toggle");
  });

  it("zero expiries — out of design space; falls through to S0 via the <= 12 branch", () => {
    // Production control surface enforces expiries ∈ {12, 30, 50, 70, 80}.
    // Stage 4 defends against malformed input by falling through cleanly
    // rather than panicking.
    expect(
      classifyScenario({ ...CANONICAL, expiries: 0, tickHz: 50 }),
    ).toBe<Scenario>("S0-baseline");
  });

  it("zero tickHz with canonical expiries — falls through to S1 (not heavy)", () => {
    // Out of design space; zero tickHz doesn't trigger the >= 100 heavy
    // branch, and expiries=70 doesn't trigger the <= 12 baseline branch.
    expect(classifyScenario({ ...CANONICAL, tickHz: 0 })).toBe<Scenario>(
      "S1-canonical",
    );
  });

  it("backward clock at bootstrap — first call still settles immediately regardless of nowMs", () => {
    // Settler's first-call bootstrap path doesn't consult nowMs; only
    // subsequent transitions do. A negative nowMs at bootstrap is fine.
    const settler = createScenarioSettler();
    expect(settler.update(SNAP_S1, -1000)).toEqual({
      type: "settled",
      scenario: "S1-canonical",
    });
  });
});

describe("Stage 4 — PLAYBOOK Scenarios 0–5 walkthrough (4.6)", () => {
  // Each PLAYBOOK scenario as the detector sees it (slice excluded — it's
  // display-only). Mirrors the tables under PLAYBOOK §Scenarios 0–5.
  const PLAYBOOK_S0 = (lastIntentToggleAgoMs: number): AppSnapshot => ({
    shockActive: false,
    tickHz: 50,
    expiries: 12,
    lastIntentToggleAgoMs,
  });
  const PLAYBOOK_S1 = (lastIntentToggleAgoMs: number): AppSnapshot => ({
    shockActive: false,
    tickHz: 50,
    expiries: 70,
    lastIntentToggleAgoMs,
  });
  const PLAYBOOK_S3 = (lastIntentToggleAgoMs: number): AppSnapshot => ({
    shockActive: false,
    tickHz: 100,
    expiries: 80,
    lastIntentToggleAgoMs,
  });
  const PLAYBOOK_S4 = (lastIntentToggleAgoMs: number): AppSnapshot => ({
    shockActive: true,
    tickHz: 50,
    expiries: 70,
    lastIntentToggleAgoMs,
  });
  const PLAYBOOK_S5 = (lastIntentToggleAgoMs: number): AppSnapshot => ({
    shockActive: true,
    tickHz: 500,
    expiries: 80,
    lastIntentToggleAgoMs,
  });

  // PLAYBOOK §Scenario 2 = PLAYBOOK_S1 settings + an intent toggle that
  // just fired. We model "just fired" with lastIntentToggleAgoMs=0.

  it("S0 settled — light surface, moderate tick → S0-baseline", () => {
    const settler = createScenarioSettler();
    expect(settler.update(PLAYBOOK_S0(Number.POSITIVE_INFINITY), 0).type).toBe(
      "settled",
    );
    // Already settled at bootstrap.
    const out = settler.update(PLAYBOOK_S0(Number.POSITIVE_INFINITY), 5000);
    expect(out).toEqual({ type: "settled", scenario: "S0-baseline" });
  });

  it("S0 → S1 transition — 70 expiries swap triggers a 2 s debounce", () => {
    const settler = createScenarioSettler();
    settler.update(PLAYBOOK_S0(Number.POSITIVE_INFINITY), 0); // settled S0

    const t1 = settler.update(PLAYBOOK_S1(Number.POSITIVE_INFINITY), 100);
    expect(t1.type).toBe("transitioning");

    const t2 = settler.update(
      PLAYBOOK_S1(Number.POSITIVE_INFINITY),
      100 + SCENARIO_DEBOUNCE_MS,
    );
    expect(t2).toEqual({ type: "settled", scenario: "S1-canonical" });
  });

  it("S1 → S2 → S1 — intent fires during S1, classifier flips, then falls back after 4 s + 2 s debounce", () => {
    const settler = createScenarioSettler();
    settler.update(PLAYBOOK_S1(Number.POSITIVE_INFINITY), 0); // settled S1

    // t=1000: intent toggle fires (lastIntentToggleAgoMs=0). Classifier
    // says S2; settler begins transitioning.
    const t1 = settler.update(PLAYBOOK_S1(0), 1000);
    expect(asTransitioning(t1).pending).toBe("S2-intent-toggle");

    // t=3000 (2 s after toggle, but the intent window is still open at
    // ms 2000 elapsed): settler promotes to S2 at the original deadline.
    const t2 = settler.update(PLAYBOOK_S1(2000), 3000);
    expect(t2).toEqual({ type: "settled", scenario: "S2-intent-toggle" });

    // t=5000: intent window has now elapsed (4001 ms since the toggle).
    // Classifier returns S1; settler begins transitioning S2 → S1.
    const t3 = settler.update(PLAYBOOK_S1(4001), 5000);
    expect(asTransitioning(t3).pending).toBe("S1-canonical");

    // t=7000: 2 s of S1 stability → settled S1.
    const t4 = settler.update(PLAYBOOK_S1(6000), 7000);
    expect(t4).toEqual({ type: "settled", scenario: "S1-canonical" });
  });

  it("S1 → S3 — heavier-surface settings transition", () => {
    const settler = createScenarioSettler();
    settler.update(PLAYBOOK_S1(Number.POSITIVE_INFINITY), 0);
    expect(
      settler.update(PLAYBOOK_S3(Number.POSITIVE_INFINITY), 500).type,
    ).toBe("transitioning");
    expect(
      settler.update(
        PLAYBOOK_S3(Number.POSITIVE_INFINITY),
        500 + SCENARIO_DEBOUNCE_MS,
      ),
    ).toEqual({ type: "settled", scenario: "S3-heavier" });
  });

  it("S1 → S4 — shock activates, settler transitions then settles", () => {
    const settler = createScenarioSettler();
    settler.update(PLAYBOOK_S1(Number.POSITIVE_INFINITY), 0);

    const t1 = settler.update(PLAYBOOK_S4(Number.POSITIVE_INFINITY), 100);
    expect(asTransitioning(t1).pending).toBe("S4-shock");

    const t2 = settler.update(
      PLAYBOOK_S4(Number.POSITIVE_INFINITY),
      100 + SCENARIO_DEBOUNCE_MS,
    );
    expect(t2).toEqual({ type: "settled", scenario: "S4-shock" });
  });

  it("S4 → S5 — shock + heaviest surface + 500 Hz upgrades pathological", () => {
    const settler = createScenarioSettler();
    settler.update(PLAYBOOK_S4(Number.POSITIVE_INFINITY), 0); // bootstrap S4 directly

    const t1 = settler.update(PLAYBOOK_S5(Number.POSITIVE_INFINITY), 500);
    expect(asTransitioning(t1).pending).toBe("S5-pathological");

    const t2 = settler.update(
      PLAYBOOK_S5(Number.POSITIVE_INFINITY),
      500 + SCENARIO_DEBOUNCE_MS,
    );
    expect(t2).toEqual({ type: "settled", scenario: "S5-pathological" });
  });

  it("intent-window closing fires only because caller updates lastIntentToggleAgoMs over time", () => {
    // Load-bearing contract test for Stage 5 integration. The scheduler
    // MUST call `update` regularly with a freshly-computed
    // `lastIntentToggleAgoMs`; the classifier alone doesn't observe
    // elapsed time. This test simulates that loop in 200 ms ticks (5 Hz
    // throttle cadence) and verifies the S2 → S1 transition fires.
    const settler = createScenarioSettler();
    const intentFiredAt = 1000;
    settler.update(PLAYBOOK_S1(Number.POSITIVE_INFINITY), 0); // settled S1

    // Intent fires at t=1000 and the scheduler keeps ticking the settler
    // every 200 ms with a freshly-computed lastIntentToggleAgoMs.
    let lastSeen: SettlerOutput | null = null;
    for (let nowMs = intentFiredAt; nowMs <= 7000; nowMs += 200) {
      const elapsed = nowMs - intentFiredAt;
      const snapshot = PLAYBOOK_S1(elapsed);
      lastSeen = settler.update(snapshot, nowMs);
    }

    // After 6 s of regular updates: window closed at intentAgo=4000 (i.e.
    // t=5000); settler debounced S2 → S1 over the next 2 s (settled at
    // t=7000). The last seen update at t=7000 should be settled S1.
    expect(lastSeen).toEqual({ type: "settled", scenario: "S1-canonical" });
  });

  it("shock-end recovery — shock flips false during S4 → returns to load/intent state", () => {
    const settler = createScenarioSettler();
    settler.update(PLAYBOOK_S4(Number.POSITIVE_INFINITY), 0); // bootstrap S4

    // Shock ends. PLAYBOOK_S4 with shockActive=false has 70 expiries +
    // 50 Hz → S1 canonical.
    const recoverySnapshot: AppSnapshot = {
      ...PLAYBOOK_S4(Number.POSITIVE_INFINITY),
      shockActive: false,
    };
    const t1 = settler.update(recoverySnapshot, 10_000);
    expect(asTransitioning(t1).pending).toBe("S1-canonical");

    const t2 = settler.update(recoverySnapshot, 10_000 + SCENARIO_DEBOUNCE_MS);
    expect(t2).toEqual({ type: "settled", scenario: "S1-canonical" });
  });
});
