// Block 2.1 — calendar-arb repair pass.
//
// Tests defined in terms of `calendarCheck` semantics (the full-grid
// detection used by both detection and post-repair verification), not
// ATM-only θ monotonicity — two slices can satisfy ATM monotonicity
// while violating the calendar bound at strikes away from ATM.
//
// Test list per ROADMAP Phase 3.5 Block 2.1:
//   1. Arb-free surface — repair is a no-op; fit params unchanged.
//   2. Constructed violation — repair restores arb-freeness; status
//      flips arb-free → repair-applied.
//   3. > 10 simultaneous violating slices — bounded at MAX_REPAIRS_PER_PASS;
//      surfaceArbStatus: "repair-failed" with reason "too-many-violations".
//   4. Pre-existing input fit failure — `pre-existing-fit-failure` is
//      returned; no repair attempted. (This covers the same "refusing to
//      emit invalid output" contract as the plan's planned degenerate-
//      quotes path — the broader failure-mode taxonomy lives on
//      `RepairResult.failureReason`.)

import { describe, expect, it } from "vitest";

import { fitSviSlice } from "../src/svi/fitter.js";
import { calendarCheck, repairCalendarArb } from "../src/svi/no-arb.js";
import type { SviParams } from "../src/svi/params.js";
import { validateParams } from "../src/svi/params.js";
import type { Quote, Slice } from "../src/svi/svi.js";
import { varianceToIv, w } from "../src/svi/svi.js";

function fixture(
  a: number,
  b: number,
  rho: number,
  m: number,
  sigma: number,
): SviParams {
  const r = validateParams({ a, b, rho, m, sigma });
  if (!r.ok) throw new Error(`fixture invalid: ${r.reason}`);
  return r.params;
}

function syntheticSlice(
  truth: SviParams,
  ks: readonly number[],
  T: number,
): Slice {
  const quotes: readonly Quote[] = ks.map((k) => ({
    logMoneyness: k,
    impliedVol: varianceToIv(w(k, truth), T),
  }));
  return { quotes, timeToExpiry: T };
}

const grid = (kMin: number, kMax: number, n: number) =>
  Array.from({ length: n }, (_, i) => kMin + (i / (n - 1)) * (kMax - kMin));

const STRIKES = Array.from({ length: 21 }, (_, i) => -1.0 + i * 0.1);
const K_GRID = grid(-0.5, 0.5, 100);

describe("repairCalendarArb (Block 2.1)", () => {
  it("(1) arb-free surface — repair is a no-op", () => {
    // Three slices with a*_T = a* · T (calendar-arb-free by
    // construction); same b/ρ/m/σ across slices.
    const ts = [0.25, 0.5, 1.0];
    const truthBase = { a: 0.04, b: 0.1, rho: -0.3, m: 0.0, sigma: 0.2 };
    const slices = ts.map((T) =>
      syntheticSlice(
        fixture(
          truthBase.a * T,
          truthBase.b,
          truthBase.rho,
          truthBase.m,
          truthBase.sigma,
        ),
        STRIKES,
        T,
      ),
    );
    const fitResults = slices.map((s) => fitSviSlice(s));
    expect(fitResults.every((r) => r.ok)).toBe(true);

    const result = repairCalendarArb(slices, fitResults, K_GRID);

    expect(result.surfaceArbStatus).toBe("arb-free");
    expect(result.initialViolationCount).toBe(0);
    expect(result.slicesRepaired).toBe(0);
    expect(result.violatingSliceCount).toBe(0);
    expect(result.failureReason).toBeUndefined();

    // No-op: returned fitResults are the same instances.
    for (let i = 0; i < fitResults.length; i++) {
      expect(result.fitResults[i]).toBe(fitResults[i]);
    }
  });

  it("(2) constructed violation — repair restores arb-freeness", () => {
    // Noise-scale violation: slice 2's `a` is marginally lower than
    // slice 1's, producing a uniform calendar-arb deficit of ~0.003
    // across the k-grid (slice 2's curve sits below slice 1's by that
    // constant). This is the noise-scale regime the repair pass is
    // designed for — soft floor lifts slice 2's `a` enough to clear.
    const p1 = fixture(0.05, 0.1, -0.3, 0.0, 0.2);
    const p2 = fixture(0.047, 0.1, -0.3, 0.0, 0.2); // 0.003 below p1 everywhere
    const slice1 = syntheticSlice(p1, STRIKES, 0.5);
    const slice2 = syntheticSlice(p2, STRIKES, 1.0);
    const slices = [slice1, slice2];
    const fitResults = slices.map((s) => fitSviSlice(s));
    expect(fitResults.every((r) => r.ok)).toBe(true);

    // Confirm the pre-repair surface violates.
    const fittedView = fitResults.map((r, i) => {
      if (!r.ok || slices[i] === undefined) throw new Error("fit failure");
      return { params: r.params, timeToExpiry: slices[i].timeToExpiry };
    });
    const pre = calendarCheck(fittedView, K_GRID);
    expect(pre.arbitrageFree).toBe(false);
    expect(pre.violations.length).toBeGreaterThan(0);

    const result = repairCalendarArb(slices, fitResults, K_GRID);

    expect(result.surfaceArbStatus).toBe("repair-applied");
    expect(result.initialViolationCount).toBe(pre.violations.length);
    expect(result.violatingSliceCount).toBe(1);
    expect(result.slicesRepaired).toBe(1);
    expect(result.remainingViolationCount).toBe(0);
    expect(result.failureReason).toBeUndefined();

    // Post-repair: slice 2's fit changed, and the surface is arb-free.
    expect(result.fitResults[1]).not.toBe(fitResults[1]);
    const postView = result.fitResults.map((r, i) => {
      if (!r.ok || slices[i] === undefined) throw new Error("post fit failure");
      return { params: r.params, timeToExpiry: slices[i].timeToExpiry };
    });
    const post = calendarCheck(postView, K_GRID);
    expect(post.arbitrageFree).toBe(true);
  });

  it("(3) > 10 simultaneous violating slices — bounded at MAX with too-many-violations", () => {
    // 12 slices with strictly decreasing total-variance levels (i.e.
    // every adjacent pair calendar-violates). Slice index i+1's curve
    // is below slice i across the k-grid for every i. That produces 11
    // violating slice-pairs, hence 11 unique target slices needing
    // re-fit — over the 10-cap.
    const aValues = [
      0.2, 0.18, 0.16, 0.14, 0.12, 0.1, 0.08, 0.06, 0.05, 0.04, 0.03, 0.02,
    ];
    const ts = aValues.map((_, i) => 0.25 + i * 0.25); // strictly increasing T
    const slices = aValues.map((a, i) => {
      const T = ts[i] as number;
      return syntheticSlice(fixture(a, 0.1, -0.3, 0.0, 0.2), STRIKES, T);
    });
    const fitResults = slices.map((s) => fitSviSlice(s));
    expect(fitResults.every((r) => r.ok)).toBe(true);

    const result = repairCalendarArb(slices, fitResults, K_GRID);

    expect(result.surfaceArbStatus).toBe("repair-failed");
    expect(result.failureReason).toBe("too-many-violations");
    expect(result.violatingSliceCount).toBe(11);
    expect(result.slicesRepaired).toBe(0); // bound trips before any re-fit
    expect(result.initialViolationCount).toBeGreaterThan(0);
    // Original fitResults returned unchanged (no re-fits attempted).
    for (let i = 0; i < fitResults.length; i++) {
      expect(result.fitResults[i]).toBe(fitResults[i]);
    }
  });

  it("(4) input fit failure produces pre-existing-fit-failure status", () => {
    // Slice 1 fits normally; slice 2 is constructed with too few quotes
    // (the 5-param fit requires ≥ MIN_QUOTES = 3) so its FitResult is a
    // FitFailure. The repair pass must refuse to attempt arb verification
    // on a surface with gaps and mark repair-failed.
    const p1 = fixture(0.04, 0.1, -0.3, 0.0, 0.2);
    const slice1 = syntheticSlice(p1, STRIKES, 0.5);
    const slice2: Slice = {
      // Only 2 quotes — under MIN_QUOTES. fitSviSlice returns underdetermined.
      quotes: [
        { logMoneyness: -0.05, impliedVol: 0.2 },
        { logMoneyness: 0.05, impliedVol: 0.2 },
      ],
      timeToExpiry: 1.0,
    };
    const fitResults = [fitSviSlice(slice1), fitSviSlice(slice2)];
    expect(fitResults[0]?.ok).toBe(true);
    expect(fitResults[1]?.ok).toBe(false);

    const result = repairCalendarArb([slice1, slice2], fitResults, K_GRID);

    expect(result.surfaceArbStatus).toBe("repair-failed");
    expect(result.failureReason).toBe("pre-existing-fit-failure");
    expect(result.slicesRepaired).toBe(0);
    // Returned fitResults are the input fitResults (no modification).
    for (let i = 0; i < fitResults.length; i++) {
      expect(result.fitResults[i]).toBe(fitResults[i]);
    }
  });
});
