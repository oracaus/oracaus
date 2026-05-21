// Property-based test for `repairCalendarArb` (Step E).
//
// Block 2.1's four unit tests cover specific scenarios (no-op, single
// uniform violation, > 10 simultaneous, pre-existing failure). They
// don't sweep across the parameter space — random violation patterns,
// varying magnitudes, varying slice indices.
//
// This test runs 200 randomised scenarios. Each scenario:
//   1. Builds a calendar-arb-free base surface (T-scaled SVI).
//   2. Perturbs a random subset of slices downward in `a` by a random
//      magnitude — creating a calendar-arb violation with that slice's
//      predecessor.
//   3. Runs the raw per-slice fits + `repairCalendarArb`.
//   4. Asserts the contract: status is one of the three valid values,
//      and if `repair-applied` the post-check verifies arb-free.
//
// Deterministic via `mulberry32(seed)` — reproducible across runs.

import { describe, expect, it } from "vitest";

import { mulberry32 } from "../src/feed.js";
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

const N_SCENARIOS = 200;
const STRIKES = Array.from({ length: 21 }, (_, i) => -1.0 + i * 0.1);
const K_GRID = Array.from({ length: 100 }, (_, i) => -0.5 + (1.0 * i) / 99);

// Base T-scaling truth — a*·T per slice; other params shared. Calendar-
// arb-free by construction; perturbations break that.
const TRUTH_A_STAR = 0.04;
const TRUTH_B = 0.1;
const TRUTH_RHO = -0.3;
const TRUTH_M = 0.0;
const TRUTH_SIGMA = 0.2;

const T_LADDER = [0.083, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0];

describe("repairCalendarArb (Step E property test)", () => {
  it("preserves the (input → output) contract across 200 random violation patterns", () => {
    const rng = mulberry32(0xc0_ff_ee);
    let arbFree = 0;
    let repaired = 0;
    let failed = 0;
    const failureReasons: Record<string, number> = {};
    for (let i = 0; i < N_SCENARIOS; i++) {
      const slices: Slice[] = [];
      for (const T of T_LADDER) {
        // Pick perturbation per slice: 30 % chance to perturb down by
        // U[0.001, 0.01]. The first slice is never perturbed (it has no
        // predecessor, so can't violate anything).
        const isFirst = slices.length === 0;
        const perturb = !isFirst && rng() < 0.3 ? -0.001 - rng() * 0.009 : 0;
        const a = Math.max(0.001, TRUTH_A_STAR * T + perturb);
        const truth = fixture(a, TRUTH_B, TRUTH_RHO, TRUTH_M, TRUTH_SIGMA);
        slices.push(syntheticSlice(truth, STRIKES, T));
      }
      const fits = slices.map((s) => fitSviSlice(s));
      // Skip scenarios where the raw fit itself failed (those exercise
      // `pre-existing-fit-failure` covered by Block 2.1 test 4).
      if (fits.some((r) => !r.ok)) continue;
      const result = repairCalendarArb(slices, fits, K_GRID);

      // Contract 1: status is always one of the three enum values.
      expect(["arb-free", "repair-applied", "repair-failed"]).toContain(
        result.surfaceArbStatus,
      );

      // Contract 2: if `repair-applied`, the post-check confirms arb-free.
      if (result.surfaceArbStatus === "repair-applied") {
        const view = result.fitResults.map((r, idx) => {
          if (!r.ok || slices[idx] === undefined) {
            throw new Error("repair-applied with unexpected gap");
          }
          return { params: r.params, timeToExpiry: slices[idx].timeToExpiry };
        });
        const post = calendarCheck(view, K_GRID);
        expect(post.arbitrageFree).toBe(true);
      }

      // Contract 3: if `repair-failed`, failureReason is set.
      if (result.surfaceArbStatus === "repair-failed") {
        expect(result.failureReason).toBeDefined();
        const reason = result.failureReason as string;
        failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
      }

      if (result.surfaceArbStatus === "arb-free") arbFree += 1;
      else if (result.surfaceArbStatus === "repair-applied") repaired += 1;
      else failed += 1;
    }

    // Outcome distribution checks — informative rather than strict, but
    // catch regressions where the repair stops doing anything.
    expect(arbFree + repaired).toBeGreaterThan(0);
    expect(repaired).toBeGreaterThan(0); // some scenarios DO need repair
    // Sanity: failure rate well below 1/2 — most scenarios should resolve.
    expect(failed / N_SCENARIOS).toBeLessThan(0.3);
  });

  it("repair-applied surfaces are byte-identical-arb-free under re-check", () => {
    // Same as Contract 2 from the main test, but with a tighter sweep
    // explicitly targeting "did the repair really clear?". Each scenario
    // picks 1–3 random slices to perturb downward by enough magnitude to
    // create a real violation against the predecessor — produces a steady
    // stream of repair-applied cases, each verified to clear arb-free.
    const rng = mulberry32(0xfa_ce);
    let casesChecked = 0;
    for (let i = 0; i < 100; i++) {
      // Pick 1–3 slice indices to perturb (skip the first slice — no
      // predecessor). Each gets a large downward shift on `a` (~0.005
      // to ~0.015), enough to violate the calendar floor against the
      // previous slice.
      const nPerturbed = 1 + Math.floor(rng() * 3);
      const perturbedIdx = new Set<number>();
      while (perturbedIdx.size < nPerturbed) {
        perturbedIdx.add(1 + Math.floor(rng() * (T_LADDER.length - 1)));
      }
      const slices: Slice[] = [];
      for (let j = 0; j < T_LADDER.length; j++) {
        const T = T_LADDER[j] as number;
        const perturb = perturbedIdx.has(j) ? -0.005 - rng() * 0.01 : 0;
        const a = Math.max(0.001, TRUTH_A_STAR * T + perturb);
        const truth = fixture(a, TRUTH_B, TRUTH_RHO, TRUTH_M, TRUTH_SIGMA);
        slices.push(syntheticSlice(truth, STRIKES, T));
      }
      const fits = slices.map((s) => fitSviSlice(s));
      if (fits.some((r) => !r.ok)) continue;
      const result = repairCalendarArb(slices, fits, K_GRID);
      if (result.surfaceArbStatus !== "repair-applied") continue;
      casesChecked += 1;
      const view = result.fitResults.map((r, idx) => {
        if (!r.ok || slices[idx] === undefined) {
          throw new Error("gap in repaired surface");
        }
        return { params: r.params, timeToExpiry: slices[idx].timeToExpiry };
      });
      const post = calendarCheck(view, K_GRID);
      expect(post.arbitrageFree).toBe(true);
      expect(post.minDelta).toBeGreaterThanOrEqual(0);
    }
    expect(casesChecked).toBeGreaterThan(10);
  });
});
