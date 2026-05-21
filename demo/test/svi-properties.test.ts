// Property-based invariants of the SVI fitter. Verifies structural
// properties that hold across many fixtures, not just hand-picked
// parameter sets. Uses a deterministic mulberry32 PRNG so the test is
// reproducible without adding `fast-check` to the demo workspace.

import { describe, expect, it } from "vitest";

import { fitSviSlice } from "../src/svi/fitter.js";
import type { SviParams } from "../src/svi/params.js";
import { validateParams } from "../src/svi/params.js";
import type { Slice } from "../src/svi/svi.js";
import { varianceToIv, w } from "../src/svi/svi.js";

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeParams(
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

function makeSlice(truth: SviParams, ks: readonly number[], T: number): Slice {
  return {
    quotes: ks.map((k) => ({
      logMoneyness: k,
      impliedVol: varianceToIv(w(k, truth), T),
    })),
    timeToExpiry: T,
  };
}

const STRIKES = Array.from({ length: 21 }, (_, i) => -1.0 + i * 0.1);

describe("SVI fitter — determinism", () => {
  it("fitting the same slice twice produces byte-identical results", () => {
    const truth = makeParams(0.04, 0.1, -0.5, 0.0, 0.2);
    const slice = makeSlice(truth, STRIKES, 1.0);
    const r1 = fitSviSlice(slice);
    const r2 = fitSviSlice(slice);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      // Object.is not just === — catches any +0/-0 or NaN drift.
      expect(Object.is(r1.params.a, r2.params.a)).toBe(true);
      expect(Object.is(r1.params.b, r2.params.b)).toBe(true);
      expect(Object.is(r1.params.rho, r2.params.rho)).toBe(true);
      expect(Object.is(r1.params.m, r2.params.m)).toBe(true);
      expect(Object.is(r1.params.sigma, r2.params.sigma)).toBe(true);
      expect(r1.iterations).toBe(r2.iterations);
      expect(Object.is(r1.residualNorm, r2.residualNorm)).toBe(true);
      expect(
        Object.is(
          r1.diagnostics.initialGuessResidualNorm,
          r2.diagnostics.initialGuessResidualNorm,
        ),
      ).toBe(true);
    }
  });

  it("determinism holds across a range of parameter regimes", () => {
    // Five distinct parameter regimes; each fitted twice; assert identical.
    const regimes: Array<{
      a: number;
      b: number;
      rho: number;
      m: number;
      sigma: number;
      T: number;
    }> = [
      { a: 0.04, b: 0.1, rho: -0.5, m: 0.0, sigma: 0.2, T: 1.0 },
      { a: 0.06, b: 0.15, rho: -0.85, m: 0.05, sigma: 0.15, T: 0.5 },
      { a: 0.012, b: 0.4, rho: -0.6, m: 0.0, sigma: 0.1, T: 30 / 365 },
      { a: 0.05, b: 0.12, rho: -0.4, m: 0.0, sigma: 0.25, T: 0.5 },
      { a: 0.02, b: 0.08, rho: 0.2, m: -0.05, sigma: 0.18, T: 2.0 },
    ];
    for (const regime of regimes) {
      const truth = makeParams(
        regime.a,
        regime.b,
        regime.rho,
        regime.m,
        regime.sigma,
      );
      const slice = makeSlice(truth, STRIKES, regime.T);
      const r1 = fitSviSlice(slice);
      const r2 = fitSviSlice(slice);
      expect(r1.ok && r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(Object.is(r1.params.a, r2.params.a)).toBe(true);
        expect(Object.is(r1.params.b, r2.params.b)).toBe(true);
        expect(Object.is(r1.params.rho, r2.params.rho)).toBe(true);
        expect(Object.is(r1.params.m, r2.params.m)).toBe(true);
        expect(Object.is(r1.params.sigma, r2.params.sigma)).toBe(true);
      }
    }
  });
});

describe("SVI fitter — structural invariants under transform", () => {
  it("scale invariance: scaling all w by α scales recovered (a, b) by α; (ρ, m, σ) unchanged", () => {
    // w(k) = a + b·(ρ·(k − m) + √((k − m)² + σ²)).
    // If we replace w with α·w (i.e. scale total variance), the LS
    // optimum has (a, b) scaled by α and (ρ, m, σ) preserved — the form
    // is linear in (a, b) and the smoother √(...) is invariant under
    // scaling of w.
    const truth = makeParams(0.04, 0.1, -0.5, 0.0, 0.2);
    const T = 1.0;
    const sliceUnit = makeSlice(truth, STRIKES, T);
    // Scaling w by α is equivalent to scaling IV² by α — i.e. multiplying
    // every IV by √α. We supply data with α = 4 (so IV_new = 2·IV_old).
    const alpha = 4;
    const sqrtAlpha = Math.sqrt(alpha);
    const sliceScaled: Slice = {
      quotes: sliceUnit.quotes.map((q) => ({
        logMoneyness: q.logMoneyness,
        impliedVol: q.impliedVol * sqrtAlpha,
      })),
      timeToExpiry: T,
    };
    const r1 = fitSviSlice(sliceUnit);
    const r2 = fitSviSlice(sliceScaled);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(Math.abs(r2.params.a - alpha * r1.params.a)).toBeLessThan(1e-3);
      expect(Math.abs(r2.params.b - alpha * r1.params.b)).toBeLessThan(1e-3);
      expect(Math.abs(r2.params.rho - r1.params.rho)).toBeLessThan(1e-3);
      expect(Math.abs(r2.params.m - r1.params.m)).toBeLessThan(1e-3);
      expect(Math.abs(r2.params.sigma - r1.params.sigma)).toBeLessThan(1e-3);
    }
  });

  it("translation invariance: shifting k by δ shifts recovered m by δ; others unchanged", () => {
    // w(k − δ + m_new) where m_new = m_old + δ leaves the form identical
    // up to a relabelling. So shifting all k by +δ should produce a fit
    // with m increased by δ.
    const truth = makeParams(0.04, 0.1, -0.5, 0.0, 0.2);
    const T = 1.0;
    const delta = 0.15;
    const sliceA = makeSlice(truth, STRIKES, T);
    const sliceB: Slice = {
      quotes: sliceA.quotes.map((q) => ({
        ...q,
        logMoneyness: q.logMoneyness + delta,
      })),
      timeToExpiry: T,
    };
    const rA = fitSviSlice(sliceA);
    const rB = fitSviSlice(sliceB);
    expect(rA.ok && rB.ok).toBe(true);
    if (rA.ok && rB.ok) {
      expect(Math.abs(rB.params.a - rA.params.a)).toBeLessThan(1e-3);
      expect(Math.abs(rB.params.b - rA.params.b)).toBeLessThan(1e-3);
      expect(Math.abs(rB.params.rho - rA.params.rho)).toBeLessThan(1e-3);
      expect(Math.abs(rB.params.m - (rA.params.m + delta))).toBeLessThan(1e-3);
      expect(Math.abs(rB.params.sigma - rA.params.sigma)).toBeLessThan(1e-3);
    }
  });

  it("idempotence: refitting on (k_i, w(k_i, fit)) recovers fit", () => {
    // After fitting once and getting `params`, generate fresh quotes from
    // those params at the same k grid, refit, and assert we recover them.
    // This catches non-idempotent fitter bugs (e.g. drift due to numerical
    // precision in the unconstrained↔constrained roundtrip).
    //
    // Both fits run with tightened tolerances so the LM lands at machine
    // precision rather than the default gradient-tolerance floor (~1e-8).
    // Without tightening, idempotence holds only to ≈2·gradTol·(1+‖p‖) ≈
    // 1e-7, which obscures whether the fitter is genuinely idempotent or
    // simply drifting within the convergence basin.
    const truth = makeParams(0.04, 0.1, -0.5, 0.0, 0.2);
    const T = 1.0;
    const tightLm = { gradientTolerance: 1e-15, stepTolerance: 1e-15 };
    const slice = makeSlice(truth, STRIKES, T);
    const first = fitSviSlice(slice, { lm: tightLm });
    expect(first.ok).toBe(true);
    if (first.ok) {
      const refitSlice: Slice = {
        quotes: STRIKES.map((k) => ({
          logMoneyness: k,
          impliedVol: varianceToIv(w(k, first.params), T),
        })),
        timeToExpiry: T,
      };
      const second = fitSviSlice(refitSlice, { lm: tightLm });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(Math.abs(second.params.a - first.params.a)).toBeLessThan(1e-12);
        expect(Math.abs(second.params.b - first.params.b)).toBeLessThan(1e-12);
        expect(Math.abs(second.params.rho - first.params.rho)).toBeLessThan(
          1e-12,
        );
        expect(Math.abs(second.params.m - first.params.m)).toBeLessThan(1e-12);
        expect(Math.abs(second.params.sigma - first.params.sigma)).toBeLessThan(
          1e-12,
        );
      }
    }
  });
});

describe("SVI fitter — calibrated range diagnostic", () => {
  it("exposes the input k-range in result.diagnostics.calibratedRange", () => {
    const truth = makeParams(0.04, 0.1, -0.5, 0.0, 0.2);
    const slice = makeSlice(truth, STRIKES, 1.0);
    const result = fitSviSlice(slice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics.calibratedRange.kMin).toBe(-1.0);
      expect(result.diagnostics.calibratedRange.kMax).toBe(1.0);
    }
  });

  it("calibratedRange handles unsorted strikes correctly", () => {
    // Quotes don't need to be sorted by k; the range should still be the
    // [min, max] of all input k values.
    const ks = [0.5, -0.3, 0.0, 0.7, -0.5, 0.2];
    const truth = makeParams(0.04, 0.1, -0.4, 0.0, 0.2);
    const T = 0.5;
    const result = fitSviSlice(makeSlice(truth, ks, T));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics.calibratedRange.kMin).toBe(-0.5);
      expect(result.diagnostics.calibratedRange.kMax).toBe(0.7);
    }
  });
});

describe("SVI fitter — randomised invariant sweep", () => {
  it("scale invariance holds across 30 randomised parameter regimes", () => {
    const rng = mulberry32(20251106);
    let failures = 0;
    for (let trial = 0; trial < 30; trial++) {
      const a = -0.001 + rng() * 0.06;
      const b = 0.05 + rng() * 0.4;
      const rho = -0.9 + rng() * 1.8;
      const m = -0.2 + rng() * 0.4;
      const sigma = 0.05 + rng() * 0.4;
      const T = 0.1 + rng() * 1.9;
      // Reject regimes that fail validation (level constraint).
      const v = validateParams({ a, b, rho, m, sigma });
      if (!v.ok) continue;
      const truth = v.params;
      const sliceA = makeSlice(truth, STRIKES, T);
      const alpha = 0.5 + rng() * 3.5;
      const sliceB: Slice = {
        quotes: sliceA.quotes.map((q) => ({
          logMoneyness: q.logMoneyness,
          impliedVol: q.impliedVol * Math.sqrt(alpha),
        })),
        timeToExpiry: T,
      };
      const rA = fitSviSlice(sliceA);
      const rB = fitSviSlice(sliceB);
      if (!rA.ok || !rB.ok) {
        failures++;
        continue;
      }
      // Tolerances chosen to match per-param tolerance scaled by α.
      const tolA = 1e-3 * Math.max(1, alpha);
      if (Math.abs(rB.params.a - alpha * rA.params.a) > tolA) failures++;
      if (Math.abs(rB.params.b - alpha * rA.params.b) > tolA) failures++;
      if (Math.abs(rB.params.rho - rA.params.rho) > 1e-2) failures++;
      if (Math.abs(rB.params.m - rA.params.m) > 1e-2) failures++;
    }
    expect(failures).toBe(0);
  });
});
