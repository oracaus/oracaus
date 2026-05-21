// Unit tests for the Stage 6 event detector — `demo/src/commentary/events.ts`.
//
// All tests feed synthetic `EventSnapshot` values; they don't drive the
// live SVI worker. PLAYBOOK-scenario walkthroughs in the "walkthrough"
// describe block (sub-step 6.7) use canonical synthetic numbers that
// mirror the live demo's distribution — Stage 7's snapshot adapter is
// what bridges this module to the live `App.tsx` state.
//
// Time is virtual: every test injects `nowMs` directly. The detector
// never reaches for `Date.now()`.

import { describe, expect, it } from "vitest";

import {
  COOLDOWN_MS,
  createEventDetector,
  type EventSnapshot,
  QUEUE_SATURATION_THRESHOLD,
  TEAR_RECOVERY_THRESHOLD,
  TEAR_START_THRESHOLD,
  TEAR_SUSTAINED_MS,
} from "../../src/commentary/events.js";

// Canonical "boring" snapshot — Scenario 0 / 1 baseline: no shock, no
// tearing, queue empty, surface arb-free, repair on, default settings.
// Mutate via `{...BASELINE, ...overrides}` per test.
const BASELINE: EventSnapshot = {
  shockActive: false,
  tornFraction: 0,
  naiveLagTicks: 0,
  pendingCount: 0,
  surfaceArbStatus: "arb-free",
  repairMode: "on",
  tickHz: 50,
  expiries: 70,
  displayMaturityYears: 1,
};

describe("createEventDetector — module surface (6.1)", () => {
  it("factory returns an object exposing `update`", () => {
    const detector = createEventDetector();
    expect(typeof detector.update).toBe("function");
  });

  it("constants exported at the locked values", () => {
    expect(TEAR_START_THRESHOLD).toBe(0.1);
    expect(TEAR_RECOVERY_THRESHOLD).toBe(0.03);
    expect(TEAR_SUSTAINED_MS).toBe(3_000);
    expect(QUEUE_SATURATION_THRESHOLD).toBe(20);
    expect(COOLDOWN_MS.ShockStart).toBe(10_000);
    expect(COOLDOWN_MS.ShockEnd).toBe(10_000);
    expect(COOLDOWN_MS.TearStart).toBe(5_000);
    expect(COOLDOWN_MS.TearRecovery).toBe(5_000);
    expect(COOLDOWN_MS.QueueSaturated).toBe(8_000);
    expect(COOLDOWN_MS.RepairFailed).toBe(10_000);
    expect(COOLDOWN_MS.IntentToggle).toBe(1_000);
    expect(COOLDOWN_MS.ControlChanged).toBe(1_000);
  });
});

// ---------------------------------------------------------------------
// Sub-step 6.2 — Edge-detection events
//
// Each edge-detected event fires once on the asymmetric transition into
// its target state. No fire on the inverse transition. No fire on first
// call (bootstrap). No fire when held continuously.
// ---------------------------------------------------------------------

describe("Edge-detection events (6.2)", () => {
  it("ShockStart fires on shockActive false → true", () => {
    const d = createEventDetector();
    expect(d.update(BASELINE, 0)).toEqual([]); // bootstrap
    const out = d.update({ ...BASELINE, shockActive: true }, 100);
    expect(out).toEqual([{ type: "ShockStart", tier: 1, timestamp: 100 }]);
  });

  it("ShockStart does NOT fire when shockActive is held true", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, shockActive: true }, 0); // bootstrap shock-on
    const out = d.update({ ...BASELINE, shockActive: true }, 100);
    expect(out).toEqual([]);
  });

  it("ShockEnd fires on shockActive true → false", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, shockActive: true }, 0);
    const out = d.update({ ...BASELINE, shockActive: false }, 100);
    expect(out).toEqual([{ type: "ShockEnd", tier: 2, timestamp: 100 }]);
  });

  it("ShockEnd does NOT fire on the false → true transition (asymmetric)", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    const out = d.update({ ...BASELINE, shockActive: true }, 100);
    expect(out.some((e) => e.type === "ShockEnd")).toBe(false);
  });

  it("RepairFailed fires when surfaceArbStatus first becomes 'repair-failed'", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    const out = d.update(
      { ...BASELINE, surfaceArbStatus: "repair-failed" },
      100,
    );
    expect(out).toEqual([{ type: "RepairFailed", tier: 1, timestamp: 100 }]);
  });

  it("RepairFailed does NOT fire on transitions between the two non-failed statuses (design contract §11)", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0); // arb-free
    const out = d.update(
      { ...BASELINE, surfaceArbStatus: "repair-applied" },
      100,
    );
    expect(out).toEqual([]);

    const back = d.update({ ...BASELINE, surfaceArbStatus: "arb-free" }, 200);
    expect(back).toEqual([]);
  });

  it("QueueSaturated fires on pendingCount rising from <20 to >=20", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, pendingCount: 19 }, 0);
    const out = d.update({ ...BASELINE, pendingCount: 20 }, 100);
    expect(out).toEqual([
      { type: "QueueSaturated", tier: 1, timestamp: 100, pendingCount: 20 },
    ]);
  });

  it("QueueSaturated does NOT re-fire when pendingCount holds at 20 across multiple updates", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, pendingCount: 19 }, 0);
    d.update({ ...BASELINE, pendingCount: 20 }, 100); // fires
    const second = d.update({ ...BASELINE, pendingCount: 20 }, 200);
    expect(second).toEqual([]);
  });

  it("QueueSaturated does NOT fire if pendingCount was already >=20 in prev (bootstrap-at-saturation case)", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, pendingCount: 25 }, 0); // bootstrap
    const out = d.update({ ...BASELINE, pendingCount: 25 }, 100);
    expect(out).toEqual([]);
  });

  it("First call (bootstrap) NEVER fires any edge event, even if state looks 'active'", () => {
    const d = createEventDetector();
    const out = d.update(
      {
        ...BASELINE,
        shockActive: true,
        pendingCount: 25,
        surfaceArbStatus: "repair-failed",
      },
      0,
    );
    expect(out).toEqual([]);
  });

  it("Multiple edges in one transition emit multiple events", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    const out = d.update(
      {
        ...BASELINE,
        shockActive: true,
        pendingCount: 20,
        surfaceArbStatus: "repair-failed",
      },
      100,
    );
    const types = out.map((e) => e.type).sort();
    expect(types).toEqual(["QueueSaturated", "RepairFailed", "ShockStart"]);
  });
});

// ---------------------------------------------------------------------
// Sub-step 6.3 — Sustained-threshold events (TearStart / TearRecovery)
//
// `tornFraction` must remain at / above (resp. below) the threshold for
// `TEAR_SUSTAINED_MS` before firing. The fired flag suppresses re-fires
// until `tornFraction` drops back out of the target range — the
// "once-per-sustained-period" invariant.
// ---------------------------------------------------------------------

describe("Sustained-threshold events — TearStart (6.3)", () => {
  it("fires after 3 s of sustained torn (tornFraction held at 0.15)", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, tornFraction: 0.15 }, 0); // bootstrap; primes candidate
    expect(d.update({ ...BASELINE, tornFraction: 0.15 }, 1_500)).toEqual([]);
    expect(d.update({ ...BASELINE, tornFraction: 0.15 }, 2_900)).toEqual([]);
    const fire = d.update({ ...BASELINE, tornFraction: 0.15 }, 3_000);
    expect(fire).toEqual([
      { type: "TearStart", tier: 1, timestamp: 3_000, tornFraction: 0.15 },
    ]);
  });

  it("does NOT fire on bootstrap, even if tornFraction is already above threshold", () => {
    const d = createEventDetector();
    const out = d.update({ ...BASELINE, tornFraction: 0.15 }, 0);
    expect(out).toEqual([]);
  });

  it("fires only ONCE per sustained period — held tornFraction for 30 s emits exactly 1 TearStart", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, tornFraction: 0.15 }, 0); // bootstrap
    let totalFires = 0;
    for (let t = 100; t <= 30_000; t += 100) {
      const out = d.update({ ...BASELINE, tornFraction: 0.15 }, t);
      totalFires += out.filter((e) => e.type === "TearStart").length;
    }
    expect(totalFires).toBe(1);
  });

  it("single-dip below threshold resets the buffer (strict semantics)", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, tornFraction: 0.15 }, 0); // bootstrap, candidate primed
    d.update({ ...BASELINE, tornFraction: 0.15 }, 1_500); // building
    // One dip below threshold:
    d.update({ ...BASELINE, tornFraction: 0.05 }, 1_600);
    // Back above; candidate must rearm from 1_700, NOT mature at 3_000:
    d.update({ ...BASELINE, tornFraction: 0.15 }, 1_700);
    const at3000 = d.update({ ...BASELINE, tornFraction: 0.15 }, 3_000);
    expect(at3000).toEqual([]); // would have fired without the dip-reset
    // But matures at 1_700 + 3_000 = 4_700:
    const at4700 = d.update({ ...BASELINE, tornFraction: 0.15 }, 4_700);
    expect(at4700.some((e) => e.type === "TearStart")).toBe(true);
  });

  it("re-fires after a full torn → recovered → torn cycle (fired flag rearms; cooldown elapsed)", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, tornFraction: 0.15 }, 0); // bootstrap; candidate primes
    d.update({ ...BASELINE, tornFraction: 0.15 }, 3_000); // first fire @ t=3_000
    // Drop below to clear fired flag.
    d.update({ ...BASELINE, tornFraction: 0.05 }, 3_500);
    // Cross back up — candidate primes at t=9_000 (well past 5 s
    // cooldown from first fire so the second emission is allowed):
    d.update({ ...BASELINE, tornFraction: 0.15 }, 9_000);
    // Matures at t=12_000; cooldown delta 12_000 − 3_000 = 9_000 ms ≥ 5 s.
    const second = d.update({ ...BASELINE, tornFraction: 0.15 }, 12_000);
    expect(second.some((e) => e.type === "TearStart")).toBe(true);
  });

  it("threshold boundary: tornFraction === 0.10 exactly counts as torn (>=)", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, tornFraction: 0.1 }, 0); // bootstrap; primes
    const fire = d.update({ ...BASELINE, tornFraction: 0.1 }, 3_000);
    expect(fire.some((e) => e.type === "TearStart")).toBe(true);
  });
});

describe("Sustained-threshold events — TearRecovery (6.3 mirror)", () => {
  // TearRecovery requires both (a) a prior TearStart fired and
  // (b) `naiveLagTicks` drained to ≤ NAIVE_LAG_RECOVERY_THRESHOLD.
  // Helper that drives a TearStart→clear sequence first, then runs
  // the recovery scenario.
  function primeWithTearStart(d: ReturnType<typeof createEventDetector>) {
    d.update({ ...BASELINE, tornFraction: 0.15, naiveLagTicks: 8 }, 0);
    d.update({ ...BASELINE, tornFraction: 0.15, naiveLagTicks: 8 }, 3_000);
    // Clear the candidate post-fire by leaving the torn range briefly
    // (so the next torn period would re-prime). 0.05 is neutral.
    d.update({ ...BASELINE, tornFraction: 0.05, naiveLagTicks: 6 }, 3_100);
  }

  it("fires after 3 s of sustained recovery (low tornFraction + low lag + prior TearStart)", () => {
    const d = createEventDetector();
    primeWithTearStart(d);
    // Recovery period — both signals low, sustained.
    d.update({ ...BASELINE, tornFraction: 0.01, naiveLagTicks: 1 }, 3_200);
    const out = d.update(
      { ...BASELINE, tornFraction: 0.01, naiveLagTicks: 1 },
      6_200,
    );
    expect(out).toEqual([
      { type: "TearRecovery", tier: 2, timestamp: 6_200, tornFraction: 0.01 },
    ]);
  });

  it("does NOT fire without a prior TearStart — low tornFraction alone is insufficient", () => {
    const d = createEventDetector();
    // Bootstrap recovered immediately, no tear ever happened.
    d.update({ ...BASELINE, tornFraction: 0.01, naiveLagTicks: 1 }, 0);
    const out = d.update(
      { ...BASELINE, tornFraction: 0.01, naiveLagTicks: 1 },
      10_000,
    );
    expect(out.some((e) => e.type === "TearRecovery")).toBe(false);
  });

  it("does NOT fire when tornFraction recovers but lag is still high (the fluke case)", () => {
    const d = createEventDetector();
    primeWithTearStart(d);
    // tornFraction is low, but naive's queue hasn't drained — lag
    // still 15 ticks (above NAIVE_LAG_RECOVERY_THRESHOLD = 10).
    // Should NOT count as recovered.
    d.update({ ...BASELINE, tornFraction: 0.01, naiveLagTicks: 15 }, 3_200);
    const out = d.update(
      { ...BASELINE, tornFraction: 0.01, naiveLagTicks: 15 },
      10_000,
    );
    expect(out.some((e) => e.type === "TearRecovery")).toBe(false);
  });

  it("fires once lag finally drains — recovery starts the buffer only when both signals satisfy", () => {
    const d = createEventDetector();
    primeWithTearStart(d);
    // tornFraction recovers immediately at t=3_100 but lag is still
    // high until t=6_000. The sustained buffer should ONLY start
    // counting from the moment both signals are satisfied.
    d.update({ ...BASELINE, tornFraction: 0.01, naiveLagTicks: 15 }, 3_100);
    d.update({ ...BASELINE, tornFraction: 0.01, naiveLagTicks: 12 }, 4_500);
    // Lag drains to 8 (≤ NAIVE_LAG_RECOVERY_THRESHOLD = 10) at 6_000;
    // buffer primes here.
    d.update({ ...BASELINE, tornFraction: 0.01, naiveLagTicks: 8 }, 6_000);
    // 3 s later, recovery fires.
    const out = d.update(
      { ...BASELINE, tornFraction: 0.01, naiveLagTicks: 1 },
      9_000,
    );
    expect(out.some((e) => e.type === "TearRecovery")).toBe(true);
  });

  it("concurrent TearStart + TearRecovery is impossible by construction (disjoint threshold ranges)", () => {
    // The gap (TEAR_RECOVERY_THRESHOLD, TEAR_START_THRESHOLD) = (0.03, 0.10)
    // is the neutral zone — tornFraction can satisfy at most one
    // threshold condition at a time.
    const d = createEventDetector();
    primeWithTearStart(d);
    d.update({ ...BASELINE, tornFraction: 0.01, naiveLagTicks: 1 }, 3_200);
    const out = d.update(
      { ...BASELINE, tornFraction: 0.01, naiveLagTicks: 1 },
      6_200,
    );
    expect(out.some((e) => e.type === "TearStart")).toBe(false);
    expect(out.some((e) => e.type === "TearRecovery")).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Sub-step 6.4 — User-driven events: IntentToggle + ControlChanged
// ---------------------------------------------------------------------

describe("User-driven events (6.4)", () => {
  it("IntentToggle fires when repairMode flips on → off, with value='off'", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, repairMode: "on" }, 0);
    const out = d.update({ ...BASELINE, repairMode: "off" }, 100);
    expect(out).toEqual([
      { type: "IntentToggle", tier: 3, timestamp: 100, value: "off" },
    ]);
  });

  it("IntentToggle does NOT emit a ControlChanged for the same change (no double-fire on repairMode)", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, repairMode: "on" }, 0);
    const out = d.update({ ...BASELINE, repairMode: "off" }, 100);
    expect(out.some((e) => e.type === "ControlChanged")).toBe(false);
  });

  it("ControlChanged fires on tickHz change with control='tickHz'", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, tickHz: 50 }, 0);
    const out = d.update({ ...BASELINE, tickHz: 100 }, 100);
    expect(out).toEqual([
      {
        type: "ControlChanged",
        tier: 4,
        timestamp: 100,
        control: "tickHz",
        value: 100,
      },
    ]);
  });

  it("ControlChanged fires on expiries change", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, expiries: 70 }, 0);
    const out = d.update({ ...BASELINE, expiries: 30 }, 100);
    expect(out).toEqual([
      {
        type: "ControlChanged",
        tier: 4,
        timestamp: 100,
        control: "expiries",
        value: 30,
      },
    ]);
  });

  it("ControlChanged fires on displayMaturityYears change (slice selector)", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, displayMaturityYears: 1 }, 0);
    const out = d.update({ ...BASELINE, displayMaturityYears: 0.5 }, 100);
    expect(out).toEqual([
      {
        type: "ControlChanged",
        tier: 4,
        timestamp: 100,
        control: "displayMaturityYears",
        value: 0.5,
      },
    ]);
  });

  it("multiple ControlChanged events in one snapshot emit independently", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    const out = d.update(
      { ...BASELINE, tickHz: 100, expiries: 30, displayMaturityYears: 0.5 },
      100,
    );
    const controlChanges = out.filter((e) => e.type === "ControlChanged");
    expect(controlChanges.length).toBe(3);
    const controls = controlChanges
      .map((e) => (e.type === "ControlChanged" ? e.control : ""))
      .sort();
    expect(controls).toEqual(["displayMaturityYears", "expiries", "tickHz"]);
  });

  it("first call (bootstrap) does NOT fire IntentToggle or ControlChanged", () => {
    const d = createEventDetector();
    // Bootstrap with values that DIFFER from BASELINE — but prev=null
    // so no edge can fire.
    const out = d.update(
      { ...BASELINE, repairMode: "off", tickHz: 200, expiries: 6 },
      0,
    );
    expect(out).toEqual([]);
  });

  it("identical snapshot to prev does NOT fire any user-driven event", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    const out = d.update(BASELINE, 100);
    expect(out).toEqual([]);
  });

  it("NaN-to-NaN on tickHz does NOT emit a phantom ControlChanged (Number.isFinite guard)", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, tickHz: Number.NaN }, 0);
    const out = d.update({ ...BASELINE, tickHz: Number.NaN }, 100);
    // Without the guard, `NaN !== NaN` would be true and leak a
    // `{ control: "tickHz", value: NaN }`. With the guard, suppressed.
    expect(out.some((e) => e.type === "ControlChanged")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Sub-step 6.5 — Cooldown enforcement
// ---------------------------------------------------------------------

describe("Cooldown enforcement (6.5)", () => {
  it("ShockStart fires once; a second ShockStart within 10 s is suppressed", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    // First fire.
    expect(
      d
        .update({ ...BASELINE, shockActive: true }, 1_000)
        .some((e) => e.type === "ShockStart"),
    ).toBe(true);
    // Drop and re-rise within the 10 s cooldown — second emission
    // suppressed.
    d.update({ ...BASELINE, shockActive: false }, 2_000);
    const second = d.update({ ...BASELINE, shockActive: true }, 3_000);
    expect(second.some((e) => e.type === "ShockStart")).toBe(false);
  });

  it("ShockStart after the 10 s window is allowed", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    d.update({ ...BASELINE, shockActive: true }, 1_000); // first fire
    d.update({ ...BASELINE, shockActive: false }, 2_000);
    const second = d.update({ ...BASELINE, shockActive: true }, 11_001);
    expect(second.some((e) => e.type === "ShockStart")).toBe(true);
  });

  it("TearStart cooldown suppresses a rapid re-fire after the fired flag rearms", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, tornFraction: 0.15 }, 0);
    d.update({ ...BASELINE, tornFraction: 0.15 }, 3_000); // first fire
    // Drop below to clear fired flag, then build again quickly:
    d.update({ ...BASELINE, tornFraction: 0.05 }, 3_100);
    d.update({ ...BASELINE, tornFraction: 0.15 }, 3_200);
    const second = d.update({ ...BASELINE, tornFraction: 0.15 }, 6_200); // 3s later — buffer matures
    // 6_200 - 3_000 = 3_200 ms < 5_000 ms cooldown → suppressed.
    expect(second.some((e) => e.type === "TearStart")).toBe(false);
  });

  it("ControlChanged cooldown is per-control (tickHz + expiries changing in rapid sequence both fire)", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    const out = d.update({ ...BASELINE, tickHz: 100, expiries: 30 }, 100);
    const controls = out
      .filter((e) => e.type === "ControlChanged")
      .map((e) => (e.type === "ControlChanged" ? e.control : ""));
    expect(controls).toContain("tickHz");
    expect(controls).toContain("expiries");
  });

  it("ControlChanged cooldown holds within the 1 s window for the SAME control", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    d.update({ ...BASELINE, tickHz: 100 }, 100); // first
    const second = d.update({ ...BASELINE, tickHz: 200 }, 500); // 400 ms later
    expect(
      second.some((e) => e.type === "ControlChanged" && e.control === "tickHz"),
    ).toBe(false);
  });

  it("IntentToggle per-type cooldown: rapid off→on→off within 1 s emits exactly ONE event", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, repairMode: "on" }, 0);
    let fires = 0;
    fires += d
      .update({ ...BASELINE, repairMode: "off" }, 100)
      .filter((e) => e.type === "IntentToggle").length;
    fires += d
      .update({ ...BASELINE, repairMode: "on" }, 300)
      .filter((e) => e.type === "IntentToggle").length;
    fires += d
      .update({ ...BASELINE, repairMode: "off" }, 700)
      .filter((e) => e.type === "IntentToggle").length;
    expect(fires).toBe(1);
  });
});

// ---------------------------------------------------------------------
// Sub-step 6.6 — Bootstrap + edge cases
// ---------------------------------------------------------------------

describe("Bootstrap + edge cases (6.6)", () => {
  it("first call returns [] and only sets prev (no events fire)", () => {
    const d = createEventDetector();
    const out = d.update(BASELINE, 0);
    expect(out).toEqual([]);
  });

  it("identical snapshot to prev returns [] (no spurious events on idempotent calls)", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    expect(d.update(BASELINE, 100)).toEqual([]);
    expect(d.update(BASELINE, 200)).toEqual([]);
  });

  it("cooldowns survive across update calls (closure preservation)", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    d.update({ ...BASELINE, shockActive: true }, 100); // fire ShockStart
    // 50 intermediate idempotent calls — cooldown must persist.
    for (let t = 200; t < 5_000; t += 100) {
      d.update({ ...BASELINE, shockActive: true }, t);
    }
    // Drop and re-rise at t=9_000 — still inside 10 s cooldown from t=100:
    d.update({ ...BASELINE, shockActive: false }, 9_000);
    const out = d.update({ ...BASELINE, shockActive: true }, 9_500);
    expect(out.some((e) => e.type === "ShockStart")).toBe(false);
  });

  it("tornFraction === TEAR_START_THRESHOLD exactly counts as torn (>= boundary)", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, tornFraction: TEAR_START_THRESHOLD }, 0);
    const out = d.update(
      { ...BASELINE, tornFraction: TEAR_START_THRESHOLD },
      3_000,
    );
    expect(out.some((e) => e.type === "TearStart")).toBe(true);
  });

  it("pendingCount === QUEUE_SATURATION_THRESHOLD exactly fires once on rising edge", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, pendingCount: 19 }, 0);
    const out = d.update(
      { ...BASELINE, pendingCount: QUEUE_SATURATION_THRESHOLD },
      100,
    );
    expect(out).toEqual([
      {
        type: "QueueSaturated",
        tier: 1,
        timestamp: 100,
        pendingCount: 20,
      },
    ]);
  });

  it("NaN in threshold-compared fields (tornFraction / pendingCount) returns [] without throwing", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    // `NaN >= 0.1` is false, `NaN < 0.1` is false (and so is `NaN >= 20`):
    // tornFraction NaN doesn't fire TearStart, doesn't reset candidate,
    // and pendingCount NaN doesn't fire QueueSaturated. No throw.
    const out = d.update(
      { ...BASELINE, tornFraction: Number.NaN, pendingCount: Number.NaN },
      100,
    );
    expect(out).toEqual([]);
  });

  it("NaN-NaN on a ControlChanged field does NOT emit a phantom event", () => {
    // Duplicate of the 6.4 test for explicit 6.6 boundary coverage.
    const d = createEventDetector();
    d.update({ ...BASELINE, expiries: Number.NaN }, 0);
    const out = d.update({ ...BASELINE, expiries: Number.NaN }, 100);
    expect(out.some((e) => e.type === "ControlChanged")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Sub-step 6.7 — PLAYBOOK acceptance walkthroughs (Scenarios 1, 2, 4, 5)
//
// Each scenario feeds the detector a synthetic sequence that mirrors the
// PLAYBOOK narrative arc. Stage 7's adapter is what bridges these
// synthetic inputs to live App.tsx state; here we verify the detector
// emits the right event timeline for the canonical narrative.
// ---------------------------------------------------------------------

describe("PLAYBOOK walkthroughs (6.7)", () => {
  it("Scenario 1 — canonical: tornFraction rises to ~12 % and holds → ONE TearStart, no further events for 30 s of steady-state tearing", () => {
    const d = createEventDetector();
    // Bootstrap with healthy surface.
    d.update({ ...BASELINE, tornFraction: 0.02 }, 0);
    let totalEvents = 0;
    // Ramp from 0.02 to 0.12 over 2 s (snapshot below threshold most of
    // the way; crosses at ~1.7 s — well before 3 s, so the sustained
    // buffer matures at threshold + 3 s).
    for (let t = 200; t <= 2_000; t += 200) {
      const torn = 0.02 + ((0.12 - 0.02) * t) / 2_000;
      totalEvents += d.update({ ...BASELINE, tornFraction: torn }, t).length;
    }
    // Hold at 0.12 for 30 s — exactly one TearStart should fire over
    // this whole period.
    let tearStartCount = 0;
    for (let t = 2_200; t <= 32_000; t += 200) {
      const out = d.update({ ...BASELINE, tornFraction: 0.12 }, t);
      tearStartCount += out.filter((e) => e.type === "TearStart").length;
      totalEvents += out.length;
    }
    expect(tearStartCount).toBe(1);
    // No spurious other-event types from steady-state tearing.
    expect(totalEvents).toBe(1);
  });

  it("Scenario 2 — intent toggle: repairMode flip fires IntentToggle once; 1 s cooldown holds", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, repairMode: "on" }, 0);
    const first = d.update({ ...BASELINE, repairMode: "off" }, 500);
    expect(first.filter((e) => e.type === "IntentToggle").length).toBe(1);
    // Flip back inside the 1 s window — suppressed.
    const second = d.update({ ...BASELINE, repairMode: "on" }, 900);
    expect(second.filter((e) => e.type === "IntentToggle").length).toBe(0);
    // Flip again past the 1 s window — allowed.
    const third = d.update({ ...BASELINE, repairMode: "off" }, 1_700);
    expect(third.filter((e) => e.type === "IntentToggle").length).toBe(1);
  });

  it("Scenario 4 — vol shock arc: ShockStart → TearStart → ShockEnd → TearRecovery", () => {
    const d = createEventDetector();
    d.update({ ...BASELINE, tornFraction: 0.01 }, 0); // healthy

    // Shock begins at t=1_000.
    const shockOn = d.update(
      { ...BASELINE, shockActive: true, tornFraction: 0.02 },
      1_000,
    );
    expect(shockOn.some((e) => e.type === "ShockStart")).toBe(true);

    // Tearing climbs during shock; crosses threshold ~t=2_000; sustained
    // through to t=5_000 (3 s buffer).
    d.update({ ...BASELINE, shockActive: true, tornFraction: 0.15 }, 2_000);
    const tearFire = d.update(
      { ...BASELINE, shockActive: true, tornFraction: 0.18 },
      5_000,
    );
    expect(tearFire.some((e) => e.type === "TearStart")).toBe(true);

    // Shock ends at t=11_000 (past 10 s shock-cooldown so ShockEnd allowed).
    const shockOff = d.update(
      { ...BASELINE, shockActive: false, tornFraction: 0.12 },
      11_000,
    );
    expect(shockOff.some((e) => e.type === "ShockEnd")).toBe(true);

    // Tearing decays; crosses recovery threshold and sustains.
    d.update({ ...BASELINE, shockActive: false, tornFraction: 0.02 }, 12_000);
    const recoverFire = d.update(
      { ...BASELINE, shockActive: false, tornFraction: 0.02 },
      15_000,
    );
    expect(recoverFire.some((e) => e.type === "TearRecovery")).toBe(true);
  });

  it("Scenario 5 — pathological: 500 Hz + 80 expiries + shock — multiple Tier-1 events fire concurrently", () => {
    const d = createEventDetector();
    // Bootstrap canonical settings.
    d.update({ ...BASELINE }, 0);
    // User cranks settings, shock fires, queue saturates, tearing
    // builds — all in one snapshot transition.
    const onset = d.update(
      {
        ...BASELINE,
        tickHz: 500,
        expiries: 80,
        shockActive: true,
        pendingCount: 20,
        tornFraction: 0.2,
      },
      1_000,
    );
    const types = onset.map((e) => e.type);
    expect(types).toContain("ShockStart");
    expect(types).toContain("QueueSaturated");
    expect(types).toContain("ControlChanged"); // multiple
    // TearStart doesn't fire on the onset tick — needs 3 s sustained.
    expect(types).toContain("ControlChanged");

    // Hold the pathological state for the sustained buffer.
    const tearFire = d.update(
      {
        ...BASELINE,
        tickHz: 500,
        expiries: 80,
        shockActive: true,
        pendingCount: 20,
        tornFraction: 0.2,
      },
      4_000,
    );
    expect(tearFire.some((e) => e.type === "TearStart")).toBe(true);

    // Continue holding — cooldowns prevent re-firing during the
    // sustained pathological state. Over the next 10 s no further
    // events should land.
    let extras = 0;
    for (let t = 4_200; t <= 14_000; t += 200) {
      extras += d.update(
        {
          ...BASELINE,
          tickHz: 500,
          expiries: 80,
          shockActive: true,
          pendingCount: 20,
          tornFraction: 0.2,
        },
        t,
      ).length;
    }
    expect(extras).toBe(0);
  });
});

// ---------------------------------------------------------------------
// Sub-step 6.8 — Output ordering convention
// ---------------------------------------------------------------------

describe("Output ordering convention (6.8)", () => {
  it("emits events ordered by tier ascending, ties broken alphabetically", () => {
    const d = createEventDetector();
    d.update(BASELINE, 0);
    // Trigger ShockStart (T1), RepairFailed (T1), QueueSaturated (T1),
    // IntentToggle (T3), ControlChanged tickHz (T4), ControlChanged
    // expiries (T4) all on one snapshot transition.
    const out = d.update(
      {
        ...BASELINE,
        shockActive: true,
        surfaceArbStatus: "repair-failed",
        pendingCount: 25,
        repairMode: "off",
        tickHz: 100,
        expiries: 30,
      },
      100,
    );
    const ordered = out.map((e) => `${e.tier}:${e.type}`);
    expect(ordered).toEqual([
      // Tier 1 alphabetical: Q < R < S.
      "1:QueueSaturated",
      "1:RepairFailed",
      "1:ShockStart",
      // Tier 3 (only one event at this tier).
      "3:IntentToggle",
      // Tier 4 alphabetical by control field ordering — but `type` is
      // the same string "ControlChanged" for both, so the relative
      // order between identical-type events is whatever the detector
      // pushed them in. Both appear:
      "4:ControlChanged",
      "4:ControlChanged",
    ]);
  });
});
