// SVI fitter performance benchmarks. Run via `npm run bench`.
//
// === Phase 2 baselines (single slice + 6 × 50 surface) ===
//
// p99 targets on M-series Mac hardware:
//   10-strike fit:  <  5 ms
//   50-strike fit:  < 15 ms
//   200-strike fit: < 40 ms
//   Full surface:   < 250 ms (50 strikes × 6 expiries)
//
// === Phase 3.5 surface scenarios (Block 1.1) ===
//
// The load-bearing claim of the realistic-scaling pivot is that the default
// surface dimension lands in the 50–150 ms p99 zone on M-series Mac without
// any compute inflation. Block 1.1 measured the candidate set and bumped the
// default from the originally-stipulated 50 × 150 to **70 × 200** — Phase 2's
// per-slice numbers extrapolated to ~75 ms at 50 × 150 but the actual
// per-slice fit at 150 strikes runs ~0.8 ms (not ~1.5 ms), so 50 × 150 lands
// at ~40 ms — sub-Form-2 zone. 70 × 200 lands at ~75 ms p99 warm — middle of
// the target band. Decision logged in ROADMAP §Phase 3.5 closure notes.
//
// Block 1.1 acceptance ranges (steady-state warm p99) and observed values:
//   6 × 50    (baseline):                Phase 2 regime; sub-Form-2 zone — observed ~2 ms
//   30 × 150  (intermediate):            [25, 80] ms — observed ~25 ms
//   50 × 150  (sub-Form-2 reference):    observed ~40 ms; documents the [30, 50) decision bracket
//   70 × 200  (default target):          [50, 150] ms — observed ~75 ms ✓
//   80 × 200  (stress):                  observed ~84 ms (under originally-budgeted [120, 300])
//
// Two bench scenarios:
//
//   - "calendar-arb detection" scenarios use calendar-arb-free synthetic
//     surfaces (a*_T = a* · T; other params shared across maturities). The
//     repair pass exits at detection — happy-path compute.
//   - "calendar-arb repair (stress)" scenario perturbs 5 of the 70 slices
//     downward in `a` to force repair re-fits with the dense-floor design
//     (floor density matches post-check k-grid; iterated up to 8 rounds).
//     Measured cost: ~+15 ms p99 on top of the happy-path ~77 ms — total
//     ~104 ms p99, still inside the [50, 150] ms Form 2 zone. Per re-fit
//     cost is ~3 ms (vs ~1.7 ms with the original sparse floor); the
//     trade-off is dense floor reduces residual-violations from ~11 % to
//     ~0.2 % on 12-slice noisy surfaces.
//
// A separate cold-start single-shot measurement is logged at module load
// before vitest's bench warmup runs. Vitest bench reports mean / median /
// p99 over steady-state samples; the cold-start single number is captured
// once and printed to stderr. The hard CI gate against gross regressions
// lives in `demo/test/svi-perf.test.ts` with coarser budgets.

import { bench, describe } from "vitest";

import { type FitResult, fitSviSlice } from "../src/svi/fitter.js";
import { calendarCheck, repairCalendarArb } from "../src/svi/no-arb.js";
import type { SviParams } from "../src/svi/params.js";
import { validateParams } from "../src/svi/params.js";
import type { Slice } from "../src/svi/svi.js";
import { varianceToIv, w } from "../src/svi/svi.js";

function fixture(
  a: number,
  b: number,
  rho: number,
  m: number,
  sigma: number,
): SviParams {
  const r = validateParams({ a, b, rho, m, sigma });
  if (!r.ok) throw new Error("fixture invalid");
  return r.params;
}

function buildSlice(nStrikes: number, T: number, truth: SviParams): Slice {
  const ks = Array.from(
    { length: nStrikes },
    (_, i) => -1.0 + (i / (nStrikes - 1)) * 2.0,
  );
  const quotes = ks.map((k) => ({
    logMoneyness: k,
    impliedVol: varianceToIv(w(k, truth), T),
  }));
  return { quotes, timeToExpiry: T };
}

const TRUTH = fixture(0.04, 0.1, -0.5, 0.0, 0.2);

// Phase 2 single-slice fixtures
const SLICE_10 = buildSlice(10, 1.0, TRUTH);
const SLICE_50 = buildSlice(50, 1.0, TRUTH);
const SLICE_200 = buildSlice(200, 1.0, TRUTH);

// Phase 2 6 × 50 surface (retained for regression continuity)
const SURFACE_TS_PHASE2 = [0.083, 0.25, 0.5, 1.0, 1.5, 2.0];
const SURFACE_SLICES_PHASE2 = SURFACE_TS_PHASE2.map((T) =>
  buildSlice(50, T, TRUTH),
);

// Phase 3.5 calendar-arb-free surfaces: a_T = a* · T (monotone in T at every
// k since the non-a term is shared across maturities); other raw-SVI params
// shared. Maturities exponentially spaced from 1w to ~3y to mimic a typical
// sell-side options-MM expiry ladder.
function buildExpiryLadder(nExpiries: number): readonly number[] {
  const tMin = 7 / 365;
  const tMax = 3.0;
  return Array.from({ length: nExpiries }, (_, i) => {
    const u = i / (nExpiries - 1);
    return tMin * (tMax / tMin) ** u;
  });
}

function buildCalendarFreeSurface(
  nExpiries: number,
  nStrikes: number,
  truth: SviParams,
): readonly Slice[] {
  const ts = buildExpiryLadder(nExpiries);
  return ts.map((T) => {
    const tScaledTruth = fixture(
      truth.a * T,
      truth.b,
      truth.rho,
      truth.m,
      truth.sigma,
    );
    return buildSlice(nStrikes, T, tScaledTruth);
  });
}

function buildKGrid(nPoints: number): readonly number[] {
  return Array.from(
    { length: nPoints },
    (_, i) => -1.0 + (i / (nPoints - 1)) * 2.0,
  );
}

const SURFACE_6x50 = buildCalendarFreeSurface(6, 50, TRUTH);
const SURFACE_30x150 = buildCalendarFreeSurface(30, 150, TRUTH);
const SURFACE_50x150 = buildCalendarFreeSurface(50, 150, TRUTH);
const SURFACE_70x200 = buildCalendarFreeSurface(70, 200, TRUTH);
const SURFACE_80x200 = buildCalendarFreeSurface(80, 200, TRUTH);

// Repair-stress surface: same dimensions as the default 70 × 200 target
// but with 5 of the 70 slices perturbed downward in `a` by Δ = 0.005,
// producing a uniform calendar-arb deficit against their predecessor.
// 5 violating slices is realistic for noise-induced violations on a
// 70-slice surface (within the 10-cap; representative of stress-but-not-
// pathological feed conditions). Each violating slice triggers a re-fit
// in the repair pass.
function buildRepairStressSurface(
  nExpiries: number,
  nStrikes: number,
  truth: SviParams,
  perturbedIndices: readonly number[],
  perturbDelta: number,
): readonly Slice[] {
  const ts = buildExpiryLadder(nExpiries);
  const perturbSet = new Set(perturbedIndices);
  return ts.map((T, idx) => {
    const aT = truth.a * T;
    const perturbedA = perturbSet.has(idx) ? aT - perturbDelta : aT;
    const tScaledTruth = fixture(
      perturbedA,
      truth.b,
      truth.rho,
      truth.m,
      truth.sigma,
    );
    return buildSlice(nStrikes, T, tScaledTruth);
  });
}

const SURFACE_70x200_STRESS = buildRepairStressSurface(
  70,
  200,
  TRUTH,
  [10, 20, 30, 40, 50],
  0.005,
);

// Shared k-grid for calendar-arb detection. 200 points matches the
// production `calendarCheck` grid resolution used by the demo worker.
const K_GRID = buildKGrid(200);

function fitSurfaceWithArbCheck(slices: readonly Slice[]): FitResult[] {
  const fitResults = slices.map((s) => fitSviSlice(s));
  const fittedSlices: Array<{ params: SviParams; timeToExpiry: number }> = [];
  for (let i = 0; i < fitResults.length; i++) {
    const r = fitResults[i];
    const s = slices[i];
    if (r?.ok && s !== undefined) {
      fittedSlices.push({ params: r.params, timeToExpiry: s.timeToExpiry });
    }
  }
  if (fittedSlices.length >= 2) {
    calendarCheck(fittedSlices, K_GRID);
  }
  return fitResults;
}

/**
 * Full repair-pass cost: per-slice fits + calendarCheck detection +
 * repair re-fits + post-check verification. Measures what the worker
 * actually does on a tick that contains violations.
 */
function fitSurfaceWithRepair(slices: readonly Slice[]): FitResult[] {
  const fitResults = slices.map((s) => fitSviSlice(s));
  const repair = repairCalendarArb(slices, fitResults, K_GRID);
  return [...repair.fitResults];
}

// Cold-start single-shot. Runs at module load before vitest's bench warmup
// JITs the function. One measurement per scenario; the JIT compile cost
// amortises across them so only the first scenario's number is truly cold.
function captureColdStart(label: string, fn: () => void): void {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  // Bench output uses stderr for vitest's own logging; stdout for the
  // single-shot cold-start record keeps it visible alongside bench tables.
  console.log(`[cold-start] ${label}: ${ms.toFixed(2)} ms`);
}

captureColdStart("6×50", () => {
  fitSurfaceWithArbCheck(SURFACE_6x50);
});
captureColdStart("30×150", () => {
  fitSurfaceWithArbCheck(SURFACE_30x150);
});
captureColdStart("50×150", () => {
  fitSurfaceWithArbCheck(SURFACE_50x150);
});
captureColdStart("70×200 (default)", () => {
  fitSurfaceWithArbCheck(SURFACE_70x200);
});
captureColdStart("80×200 (stress)", () => {
  fitSurfaceWithArbCheck(SURFACE_80x200);
});

describe("SVI fit — single slice (Phase 2 baselines)", () => {
  bench("10-strike", () => {
    fitSviSlice(SLICE_10);
  });

  bench("50-strike", () => {
    fitSviSlice(SLICE_50);
  });

  bench("200-strike", () => {
    fitSviSlice(SLICE_200);
  });
});

describe("SVI fit — full surface (Phase 2 baseline: 50 strikes × 6 expiries)", () => {
  bench("full-surface", () => {
    for (const slice of SURFACE_SLICES_PHASE2) {
      fitSviSlice(slice);
    }
  });
});

describe("SVI surface fit + calendar-arb detection (Phase 3.5)", () => {
  bench("6×50 (baseline)", () => {
    fitSurfaceWithArbCheck(SURFACE_6x50);
  });

  bench("30×150 (intermediate)", () => {
    fitSurfaceWithArbCheck(SURFACE_30x150);
  });

  bench("50×150", () => {
    fitSurfaceWithArbCheck(SURFACE_50x150);
  });

  bench("70×200 (default)", () => {
    fitSurfaceWithArbCheck(SURFACE_70x200);
  });

  bench("80×200 (stress)", () => {
    fitSurfaceWithArbCheck(SURFACE_80x200);
  });
});

// Repair-stress scenario — measures the full worker path including
// re-fits. 5 violating slices on a 70 × 200 surface is the realistic
// upper end of noise-induced violations (still within the 10-cap). The
// re-fits add `repair-applied`-class cost on top of the detection path.
describe("SVI surface fit + calendar-arb repair (Phase 3.5 stress)", () => {
  bench("70×200 + 5 violating slices (repair-applied)", () => {
    fitSurfaceWithRepair(SURFACE_70x200_STRESS);
  });
});
