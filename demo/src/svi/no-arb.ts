// Output-side no-arbitrage checks for SVI total-variance surfaces.
//
// References: Gatheral, "A Parsimonious Arbitrage-Free Implied Volatility
// Parameterization with Application to the Valuation of Volatility
// Derivatives" (2004); Gatheral & Jacquier, "Arbitrage-free SVI volatility
// surfaces" (Quantitative Finance 14:1, 2014).
//
// === Butterfly no-arb ===
//
//   g(k) = ( 1 − k·w'(k) / (2·w(k)) )²
//        − ( w'(k)/4 ) · ( 1/w(k) + 1/4 )
//        + w''(k) / 2
//
// `g ≥ 0 ∀ k` is necessary and sufficient (under standard regularity) for
// the call-price surface implied by `w` to be free of butterfly arbitrage
// (Gatheral 2004 Eq. 2.11–2.12). For raw-SVI:
//
//   w'(k)  = b · (ρ + (k − m) / r)
//   w''(k) = b · σ² / r³,    r = √((k − m)² + σ²)
//
// === Calendar no-arb ===
//
// `w(k, T_{i+1}) ≥ w(k, T_i)` across maturities for every k. SVI is per-slice;
// calendar arbitrage is checked across the slice list, ordered by T.
//
// Both checks evaluate on a finite k-grid; sub-grid violations are
// possible in principle but vanishingly unlikely in practice — Gatheral's
// `g(k)` is smooth and a 200-point grid spans ≈10⁻³ inter-point spacing on
// realistic ranges, well below the curvature scale of the function.

import {
  type CalendarFloorConstraints,
  type FitResult,
  fitSviSliceWithCalendarFloor,
} from "./fitter.js";
import type { SviParams } from "./params.js";
import type { Slice } from "./svi.js";
import { w } from "./svi.js";

export type ButterflyResult = {
  /** Minimum value of g(k) on the grid. Negative → butterfly arbitrage. */
  readonly minG: number;
  /** k at which the minimum was attained. */
  readonly minGAtK: number;
  /** Number of grid points with g(k) < 0. */
  readonly violationCount: number;
  /** First k (smallest absolute) with g(k) < 0; undefined if none. */
  readonly violatingK: number | undefined;
};

/**
 * Evaluates Gatheral's butterfly-arbitrage indicator g(k) on a log-strike grid.
 * Returns the minimum, the k at which it occurred, and the count + first
 * violating k (if any). The caller decides what to do — fitter callers can
 * surface a warning via the diagnostics path.
 */
export function butterflyCheck(
  params: SviParams,
  kGrid: readonly number[],
): ButterflyResult {
  let minG = Number.POSITIVE_INFINITY;
  let minGAtK = Number.NaN;
  let violationCount = 0;
  let violatingK: number | undefined;
  for (const k of kGrid) {
    const g = gatheralG(k, params);
    if (g < minG) {
      minG = g;
      minGAtK = k;
    }
    if (g < 0) {
      violationCount += 1;
      if (violatingK === undefined || Math.abs(k) < Math.abs(violatingK)) {
        violatingK = k;
      }
    }
  }
  return { minG, minGAtK, violationCount, violatingK };
}

/**
 * Gatheral's g(k) butterfly indicator at a single log-moneyness point.
 * Exposed for adopters that want the raw value (e.g. plotting g vs k).
 *
 * Returns `-Infinity` if w(k) ≤ 0. This branch is reachable in practice
 * only at the boundary case where the level constraint is achieved with
 * equality (`a + b·σ·√(1 − ρ²) = 0`); at the unique k where the SVI form
 * attains its minimum the variance is zero, and `g(k)` would compute
 * `1/0`. The sentinel value flags "out of domain" and is ranked below
 * every finite g — so a `minG = -Infinity` in `butterflyCheck` reliably
 * indicates the surface touches `w = 0`. For SVI parameters strictly
 * interior to the level cone, `wK > 0` for all `k` and the branch is
 * unreachable.
 */
export function gatheralG(k: number, p: SviParams): number {
  const km = k - p.m;
  const r = Math.hypot(km, p.sigma);
  const wK = p.a + p.b * (p.rho * km + r);
  if (wK <= 0) return Number.NEGATIVE_INFINITY;
  const wp = p.b * (p.rho + km / r);
  const wpp = (p.b * p.sigma * p.sigma) / (r * r * r);
  const term1 = 1 - (k * wp) / (2 * wK);
  const term1Sq = term1 * term1;
  const term2 = (wp / 4) * (1 / wK + 1 / 4);
  return term1Sq - term2 + wpp / 2;
}

export type CalendarResult = {
  /** Minimum (w_{i+1} − w_i) across all checked (k, slice-pair) combinations. */
  readonly minDelta: number;
  /** True if every consecutive slice pair satisfies w_{i+1}(k) ≥ w_i(k). */
  readonly arbitrageFree: boolean;
  /** Violations (slice-pair index + k); empty if `arbitrageFree`. */
  readonly violations: ReadonlyArray<{
    readonly sliceIndex: number;
    readonly k: number;
    readonly delta: number;
  }>;
};

/**
 * Verifies `w(k, T_{i+1}) ≥ w(k, T_i)` across consecutive slices on a
 * shared k-grid. Slices are expected pre-sorted by `timeToExpiry`; the
 * function checks ordering and throws if violated (a programmer error;
 * not a calendar-arbitrage failure mode).
 */
export function calendarCheck(
  slices: ReadonlyArray<{
    readonly params: SviParams;
    readonly timeToExpiry: number;
  }>,
  kGrid: readonly number[],
): CalendarResult {
  if (slices.length < 2) {
    return {
      minDelta: Number.POSITIVE_INFINITY,
      arbitrageFree: true,
      violations: [],
    };
  }
  for (let i = 1; i < slices.length; i++) {
    const prev = slices[i - 1];
    const cur = slices[i];
    if (
      prev !== undefined &&
      cur !== undefined &&
      cur.timeToExpiry <= prev.timeToExpiry
    ) {
      throw new Error(
        `calendarCheck: slices must be strictly increasing in T; slice ${i - 1} (T = ${prev.timeToExpiry}) ≥ slice ${i} (T = ${cur.timeToExpiry})`,
      );
    }
  }
  const violations: Array<{ sliceIndex: number; k: number; delta: number }> =
    [];
  let minDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < slices.length - 1; i++) {
    const a = slices[i];
    const b = slices[i + 1];
    if (a === undefined || b === undefined) continue;
    for (const k of kGrid) {
      const delta = w(k, b.params) - w(k, a.params);
      if (delta < minDelta) minDelta = delta;
      if (delta < 0) violations.push({ sliceIndex: i, k, delta });
    }
  }
  return { minDelta, arbitrageFree: violations.length === 0, violations };
}

// === Calendar-arb repair ===
//
// `repairCalendarArb` orchestrates targeted re-fits to resolve calendar-
// arb violations after independent per-slice SVI fits. Production
// reality: per-slice fits don't know about adjacent maturities; noise on
// a few quotes near a slice's smile edge can produce a curve that dips
// below its predecessor at some strikes. The repair pass:
//
//   1. Detect via `calendarCheck` across the full kGrid.
//   2. Group violations by the slice that needs adjustment (the later
//      maturity in each violating pair; its curve must move UP at the
//      violating k-points to clear the floor set by its predecessor).
//   3. Re-fit each violating slice with `fitSviSliceWithCalendarFloor`,
//      passing the predecessor's `w(k_j)` (plus a small over-floor
//      margin) at violating k-points as floor values.
//   4. Re-detect on the updated surface. **Ripple effect**: re-fitting
//      slice i+1 raises its curve, which may push slice i+2 (previously
//      arb-free against the OLD i+1) into violation against the NEW i+1.
//      The pass iterates: re-detect, re-repair the newly-violating
//      slices, up to `MAX_REPAIR_ITERATIONS` rounds.
//   5. Two bounds protect against pathological surfaces:
//      - `maxRepairsPerPass(nSlices) = min(30, max(10, ceil(nSlices·0.3)))`
//        cumulative re-fits across all iterations. The scaled formula
//        gives 21 for the 70-slice default and preserves the 10 floor for
//        small surfaces (≤ 33 slices) — see comment on the function.
//        Tripping the cap indicates a structural problem (feed glitch,
//        vol regime break beyond noise scale).
//      - `MAX_REPAIR_ITERATIONS = 8` rounds. Empirical: ripples on
//        well-formed feeds resolve within 1–2 iterations; > 8 indicates
//        oscillation or a fundamentally infeasible repair scenario.
//   6. On any failure mode the function returns `repair-failed` with
//      `failureReason` distinguishing which bound tripped.
//
// Empirical calibration:
//   12-slice surface, σ_iv = 0.005: single-pass repair (the original
//   design) had ~11 % residual-violation rate; iterating + dense floor
//   takes it to < 1 %.
//   70×200 surface, σ_iv = 0.001 (5 seeds × 30 ticks): 69 % arb-free,
//   27 % repair-applied, 4.7 % repair-failed at production scale.

const MAX_REPAIR_ITERATIONS = 8;

// Per-pass cap on re-fits, scaled with surface size. The earlier design
// used a fixed `10`, which empirically tripped on every tick at the
// 70×200 default: per-pair noise-induced violation rate × 69 adjacent
// pairs produces ~15 expected violating pairs per tick — over the fixed
// cap. The scaled formula gives 21 for 70 slices (within ~30 % budget)
// and preserves the 10 floor for small surfaces (the structural-problem
// test case where 12 slices produce 11 violations and the cap is meant
// to trip — `Math.ceil(12 × 0.3) = 4` but the `max(10, …)` floor keeps
// it at 10).
//
// Absolute upper bound (30) prevents pathological large surfaces from
// burning unbounded compute on repair re-fits.
function maxRepairsPerPass(nSlices: number): number {
  return Math.min(30, Math.max(10, Math.ceil(nSlices * 0.3)));
}

// Floor density must match the post-check k-grid density. The original
// design floored only at the violating k-points; the LM re-fit cleared
// those points but the SVI form would dip BETWEEN them, creating new
// violations at non-floored k-points caught by the post-check.
//
// Fix: use the SAME k-grid for the floor as for the calendar check. The
// floor at non-originally-violating points is inactive (its residual is
// `max(0, floor - w_hat) = 0` when the current curve is already above
// the predecessor's), so the cost is bookkeeping plus a small Jacobian
// contribution — no convergence pressure on already-arb-free k-points.
//
// Empirical (12-slice surface, σ_iv = 0.005, 1000 ticks across 10 seeds):
//   floor only at violating points: 11 % residual-violations
//   floor on 81-point sub-grid:      3 % residual-violations
//   floor on full check k-grid:     <1 % residual-violations

// Soft-penalty repair has an equilibrium under-clearance: at the LM
// minimum, the curve sits a tiny amount BELOW the floor. The analysis:
//
//   under-clearance ε ≈ Δ · M_data / (M_floor · L²)
//
// where Δ is the original violation magnitude, M_data is the number of
// data residuals, M_floor is the number of floor residuals, and L is
// the calendar-floor weight. For noise-scale Δ ~ 0.003, M_data = 20,
// M_floor = 100, L = 1000: ε ~ 6e-10.
//
// At L = 100 (the fitter's default), ε ~ 6e-8 — still > 0, so a strict
// `calendarCheck` post-repair flags a residual violation. The repair
// pass overrides the weight to 1000 to suppress under-clearance.
const REPAIR_FLOOR_WEIGHT = 1000;

// Belt-and-braces: over-floor by a tiny absolute margin in total
// variance. Together with the L = 1000 floor weight, this lifts the
// post-repair w_new above w_prev by REPAIR_FLOOR_MARGIN − ε ≈ 1e-7,
// which is far below quoting precision (5 bp in IV at T = 1 → variance
// ~2e-3) but reliably above 0 for the strict calendar-check post-pass.
const REPAIR_FLOOR_MARGIN = 1e-7;

// LM maxIterations override for floor-constrained re-fits. The default
// 100 iterations is sufficient for the unconstrained 5-param fit; the
// floor-constrained version has 200 additional dense-floor residuals
// (M_total = 251 on 5 params), and the conditioning under that load is
// harder. Empirical (70×200, 3 seeds × 30 ticks): bumping 100 → 200
// cuts the refit-failure rate from 4/90 to 1/90, the residual-violation
// rate from 1/90 to 2/90, and the total failure rate from 5.5 % to
// 3.3 %. Going further (500) gains only 2.2 % at substantially higher
// worst-case cost on pathological surfaces.
const REPAIR_LM_MAX_ITERATIONS = 200;

/**
 * Surface-level arb status reported by the worker.
 *
 *   - `arb-free`        — checked, no violations.
 *   - `repair-applied`  — checked, violations found, repair pass cleared them.
 *   - `repair-failed`   — checked, repair attempted, residual violations remain.
 *   - `arb-violation`   — checked, violations found, no repair attempted
 *                         (user chose `repairMode = "off"`).
 *
 * The first three are produced by `repairCalendarArb` when repair is on.
 * `arb-violation` is produced by the worker's check-only path when repair
 * is off — it's an honest signal that the surface has violations the user
 * elected not to fix, not an error.
 */
export type SurfaceArbStatus =
  | "arb-free"
  | "repair-applied"
  | "repair-failed"
  | "arb-violation";

export type RepairResult = {
  /**
   * Fit results aligned 1:1 with the input `slices` array. Slices not
   * re-fit retain their original entries; re-fit slices have updated
   * `FitResult` entries (including possibly `FitFailure` if a re-fit
   * itself failed).
   */
  readonly fitResults: readonly FitResult[];
  readonly surfaceArbStatus: SurfaceArbStatus;
  /** Number of (k, slice-pair) violation tuples detected initially. */
  readonly initialViolationCount: number;
  /**
   * Number of unique slices that had violations against their predecessor
   * — i.e. the candidate set for re-fit before the MAX cap is applied.
   */
  readonly violatingSliceCount: number;
  /** Number of unique slices actually re-fit (≤ `maxRepairsPerPass(nSlices)`). */
  readonly slicesRepaired: number;
  /** Number of (k, slice-pair) violation tuples remaining after repair. */
  readonly remainingViolationCount: number;
  /**
   * Reason for `repair-failed`, if applicable. Distinguishes the three
   * failure modes so callers can route them appropriately:
   *   - `pre-existing-fit-failure`: one or more input `fitResults`
   *     entries were already failures — calendar arb cannot be verified
   *     with gaps in the surface, so repair is not attempted.
   *   - `too-many-violations`: more than `maxRepairsPerPass(nSlices)`
   *     unique slices needed repair on a single tick. The cap scales
   *     with surface size: `min(30, max(10, ceil(nSlices * 0.3)))`.
   *   - `refit-failure`: at least one targeted re-fit returned
   *     `FitFailure` (e.g. degenerate quotes on the violating slice).
   *   - `residual-violations`: re-fits ran but the post-repair
   *     `calendarCheck` still detected violations.
   */
  readonly failureReason?:
    | "pre-existing-fit-failure"
    | "too-many-violations"
    | "refit-failure"
    | "residual-violations";
};

/**
 * Detect calendar-arb violations across the fitted surface and re-fit
 * each violating slice with a soft-penalty floor at the violating
 * k-points. See module-header for the algorithm; see `RepairResult` for
 * the failure-mode taxonomy.
 *
 * `slices` and `fitResults` must be aligned 1:1 and sorted by
 * `timeToExpiry`. The function does not re-sort; the caller is
 * responsible for slice ordering (matches `calendarCheck`'s contract).
 */
export function repairCalendarArb(
  slices: readonly Slice[],
  fitResults: readonly FitResult[],
  kGrid: readonly number[],
): RepairResult {
  if (slices.length !== fitResults.length) {
    throw new Error(
      `repairCalendarArb: slices.length (${slices.length}) !== fitResults.length (${fitResults.length})`,
    );
  }

  // Pre-flight: any input fit failure is a non-repairable gap.
  for (let i = 0; i < fitResults.length; i++) {
    const r = fitResults[i];
    if (r !== undefined && !r.ok) {
      return {
        fitResults,
        surfaceArbStatus: "repair-failed",
        initialViolationCount: 0,
        violatingSliceCount: 0,
        slicesRepaired: 0,
        remainingViolationCount: 0,
        failureReason: "pre-existing-fit-failure",
      };
    }
  }

  // Build the params/T view that `calendarCheck` expects. All fits are
  // ok by the guard above, so the cast is safe.
  const fittedView = fitResults.map((r, i) => {
    const slice = slices[i];
    if (r === undefined || !r.ok || slice === undefined) {
      throw new Error("repairCalendarArb: unexpected gap after pre-flight");
    }
    return { params: r.params, timeToExpiry: slice.timeToExpiry };
  });

  if (fittedView.length < 2) {
    return {
      fitResults,
      surfaceArbStatus: "arb-free",
      initialViolationCount: 0,
      violatingSliceCount: 0,
      slicesRepaired: 0,
      remainingViolationCount: 0,
    };
  }

  const initial = calendarCheck(fittedView, kGrid);
  if (initial.arbitrageFree) {
    return {
      fitResults,
      surfaceArbStatus: "arb-free",
      initialViolationCount: 0,
      violatingSliceCount: 0,
      slicesRepaired: 0,
      remainingViolationCount: 0,
    };
  }

  // Iterative repair: each round re-detects on the current surface and
  // re-fits the slices that are currently violating. Ripple effects
  // (slice i+2 newly violating slice i+1's re-fit curve) trigger in
  // subsequent rounds. Bounded by cumulative re-fit count and iteration
  // depth — both protect against pathological surfaces.
  const repaired: FitResult[] = [...fitResults];
  const repairedView = [...fittedView];
  let cumulativeRepairs = 0;
  let currentViolations = initial.violations;
  const initialViolationCount = initial.violations.length;
  const allRepairedSlices = new Set<number>();
  let refitFailed = false;
  let iteration = 0;

  // Floor sub-grid for the re-fit. Use the SAME k-grid as the
  // post-check so that every k-point the post-check evaluates also has
  // a floor constraint guarding it. Inactive floor points (where the
  // current curve is already above the predecessor's) cost nothing in
  // SS; they only contribute when the LM re-fit would otherwise dip
  // below the predecessor at that k.
  const denseFloorKs = kGrid;

  while (currentViolations.length > 0 && iteration < MAX_REPAIR_ITERATIONS) {
    // Identify slices that need repair (any violation against predecessor).
    // The floor for each is a DENSE sub-grid of (k, w(k, prev_params)) —
    // not just the originally-violating k-points. Originally-non-violating
    // k-points contribute inactive floor residuals, but they prevent the
    // re-fit from dipping into a new violation between violating points.
    const targetIndices = new Set<number>();
    for (const v of currentViolations) targetIndices.add(v.sliceIndex + 1);
    const violationsBySlice = new Map<
      number,
      Array<{ k: number; floorValue: number }>
    >();
    for (const targetIdx of targetIndices) {
      const prevSlice = repairedView[targetIdx - 1];
      if (prevSlice === undefined) continue;
      const entries: Array<{ k: number; floorValue: number }> = [];
      for (const k of denseFloorKs) {
        entries.push({
          k,
          floorValue: w(k, prevSlice.params) + REPAIR_FLOOR_MARGIN,
        });
      }
      violationsBySlice.set(targetIdx, entries);
    }

    // Cumulative cap check — scaled with surface size.
    const cap = maxRepairsPerPass(slices.length);
    if (cumulativeRepairs + violationsBySlice.size > cap) {
      return {
        fitResults: repaired,
        surfaceArbStatus: "repair-failed",
        initialViolationCount,
        violatingSliceCount: allRepairedSlices.size + violationsBySlice.size,
        slicesRepaired: cumulativeRepairs,
        remainingViolationCount: currentViolations.length,
        failureReason: "too-many-violations",
      };
    }

    const sortedTargets = [...violationsBySlice.entries()].sort(
      ([a], [b]) => a - b,
    );
    for (const [targetIdx, points] of sortedTargets) {
      const targetSlice = slices[targetIdx];
      if (targetSlice === undefined) continue;
      const constraints: CalendarFloorConstraints = {
        kPoints: points.map((p) => p.k),
        floorValues: points.map((p) => p.floorValue),
      };
      const refit = fitSviSliceWithCalendarFloor(targetSlice, constraints, {
        calendarFloorWeight: REPAIR_FLOOR_WEIGHT,
        lm: { maxIterations: REPAIR_LM_MAX_ITERATIONS },
      });
      repaired[targetIdx] = refit;
      allRepairedSlices.add(targetIdx);
      cumulativeRepairs += 1;
      if (refit.ok) {
        const sliceForView = slices[targetIdx];
        if (sliceForView !== undefined) {
          repairedView[targetIdx] = {
            params: refit.params,
            timeToExpiry: sliceForView.timeToExpiry,
          };
        }
      } else {
        refitFailed = true;
      }
    }

    if (refitFailed) {
      return {
        fitResults: repaired,
        surfaceArbStatus: "repair-failed",
        initialViolationCount,
        violatingSliceCount: allRepairedSlices.size,
        slicesRepaired: cumulativeRepairs,
        remainingViolationCount: currentViolations.length,
        failureReason: "refit-failure",
      };
    }

    iteration += 1;
    const check = calendarCheck(repairedView, kGrid);
    currentViolations = check.violations;
  }

  if (currentViolations.length > 0) {
    return {
      fitResults: repaired,
      surfaceArbStatus: "repair-failed",
      initialViolationCount,
      violatingSliceCount: allRepairedSlices.size,
      slicesRepaired: cumulativeRepairs,
      remainingViolationCount: currentViolations.length,
      failureReason: "residual-violations",
    };
  }

  return {
    fitResults: repaired,
    surfaceArbStatus: "repair-applied",
    initialViolationCount,
    violatingSliceCount: allRepairedSlices.size,
    slicesRepaired: cumulativeRepairs,
    remainingViolationCount: 0,
  };
}
