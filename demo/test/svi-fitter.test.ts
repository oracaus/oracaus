import { describe, expect, it } from "vitest";

import { fitSviSlice } from "../src/svi/fitter.js";
import type { SviParams } from "../src/svi/params.js";
import { validateParams } from "../src/svi/params.js";
import type { Quote, Slice } from "../src/svi/svi.js";
import { varianceToIv, w } from "../src/svi/svi.js";

const PER_PARAM_TOLERANCE = {
  a: 1e-4,
  b: 1e-3,
  rho: 1e-3,
  m: 1e-3,
  sigma: 1e-4,
} as const;

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

describe("fitSviSlice — round-trip on synthetic Gatheral-style SPX", () => {
  it("recovers all five params within per-parameter tolerance", () => {
    const truth = fixture(0.04, 0.1, -0.5, 0.0, 0.2);
    const T = 1.0;
    const ks = Array.from({ length: 21 }, (_, i) => -1.0 + i * 0.1);
    const slice = syntheticSlice(truth, ks, T);
    const result = fitSviSlice(slice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const p = result.params;
      expect(Math.abs(p.a - truth.a)).toBeLessThan(PER_PARAM_TOLERANCE.a);
      expect(Math.abs(p.b - truth.b)).toBeLessThan(PER_PARAM_TOLERANCE.b);
      expect(Math.abs(p.rho - truth.rho)).toBeLessThan(PER_PARAM_TOLERANCE.rho);
      expect(Math.abs(p.m - truth.m)).toBeLessThan(PER_PARAM_TOLERANCE.m);
      expect(Math.abs(p.sigma - truth.sigma)).toBeLessThan(
        PER_PARAM_TOLERANCE.sigma,
      );
      expect(result.iterations).toBeLessThan(100);
    }
  });

  it("recovers a strongly-skewed slice (ρ = -0.85) within tolerance", () => {
    const truth = fixture(0.06, 0.15, -0.85, 0.05, 0.15);
    const T = 0.5;
    const ks = Array.from({ length: 17 }, (_, i) => -0.8 + i * 0.1);
    const slice = syntheticSlice(truth, ks, T);
    const result = fitSviSlice(slice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const p = result.params;
      expect(Math.abs(p.a - truth.a)).toBeLessThan(PER_PARAM_TOLERANCE.a);
      expect(Math.abs(p.b - truth.b)).toBeLessThan(PER_PARAM_TOLERANCE.b);
      expect(Math.abs(p.rho - truth.rho)).toBeLessThan(PER_PARAM_TOLERANCE.rho);
      expect(Math.abs(p.m - truth.m)).toBeLessThan(PER_PARAM_TOLERANCE.m);
      expect(Math.abs(p.sigma - truth.sigma)).toBeLessThan(
        PER_PARAM_TOLERANCE.sigma,
      );
    }
  });

  it("recovers a high-vol short-expiry slice (T = 0.083, ATM IV ≈ 0.4)", () => {
    const truth = fixture(0.012, 0.4, -0.6, 0.0, 0.1);
    const T = 30 / 365;
    const ks = Array.from({ length: 15 }, (_, i) => -0.4 + i * 0.05);
    const slice = syntheticSlice(truth, ks, T);
    const result = fitSviSlice(slice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const p = result.params;
      expect(Math.abs(p.a - truth.a)).toBeLessThan(PER_PARAM_TOLERANCE.a);
      expect(Math.abs(p.b - truth.b)).toBeLessThan(PER_PARAM_TOLERANCE.b);
      expect(Math.abs(p.rho - truth.rho)).toBeLessThan(PER_PARAM_TOLERANCE.rho);
      expect(Math.abs(p.m - truth.m)).toBeLessThan(PER_PARAM_TOLERANCE.m);
      expect(Math.abs(p.sigma - truth.sigma)).toBeLessThan(
        PER_PARAM_TOLERANCE.sigma,
      );
    }
  });

  it("heavy ATM weighting on noisy data tightens the ATM fit", () => {
    // Noiseless data has its optimum at truth regardless of weights, so a
    // weight test on clean data is a non-test. With noise added, the
    // unweighted optimum shifts away from truth in a noise-dependent way;
    // heavy ATM weighting biases the fit toward better ATM accuracy at
    // the cost of wing accuracy. Asserting that ATM residual under heavy
    // weighting is strictly smaller than under uniform weighting verifies
    // the weighted-LS path is genuinely active.
    const truth = fixture(0.04, 0.1, -0.4, 0.0, 0.2);
    const T = 0.5;
    const ks = Array.from({ length: 13 }, (_, i) => -0.6 + i * 0.1);
    const cleanIvs = ks.map((k) => varianceToIv(w(k, truth), T));
    // Deterministic noise — same fixture every run.
    const rng = mulberry32(20251106);
    const noisyIvs = cleanIvs.map((iv) => iv + (rng() - 0.5) * 0.01);

    const uniformQuotes = ks.map((k, i) => ({
      logMoneyness: k,
      impliedVol: noisyIvs[i] ?? 0.2,
    }));
    const heavyAtmQuotes = ks.map((k, i) => ({
      logMoneyness: k,
      impliedVol: noisyIvs[i] ?? 0.2,
      weight: Math.abs(k) < 0.05 ? 100 : 1,
    }));
    const r1 = fitSviSlice({ quotes: uniformQuotes, timeToExpiry: T });
    const r2 = fitSviSlice({ quotes: heavyAtmQuotes, timeToExpiry: T });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      const atmIdx = ks.findIndex((k) => Math.abs(k) < 0.05);
      const atmK = ks[atmIdx] ?? 0;
      const atmW = (noisyIvs[atmIdx] ?? 0) ** 2 * T;
      const r1AtmRes = Math.abs(w(atmK, r1.params) - atmW);
      const r2AtmRes = Math.abs(w(atmK, r2.params) - atmW);
      expect(r2AtmRes).toBeLessThan(r1AtmRes);
      // The two fits are genuinely different — recovered params differ
      // by more than rounding noise.
      const paramDiff =
        Math.abs(r1.params.a - r2.params.a) +
        Math.abs(r1.params.b - r2.params.b) +
        Math.abs(r1.params.rho - r2.params.rho);
      expect(paramDiff).toBeGreaterThan(1e-6);
    }
  });
});

// Small deterministic PRNG (mulberry32) for reproducible noise.
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

describe("fitSviSlice — fit accuracy at observed strikes", () => {
  it("fits IV at every observed strike within 0.5 % relative", () => {
    const truth = fixture(0.04, 0.1, -0.5, 0.0, 0.2);
    const T = 1.0;
    const ks = Array.from({ length: 21 }, (_, i) => -1.0 + i * 0.1);
    const slice = syntheticSlice(truth, ks, T);
    const result = fitSviSlice(slice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      let maxRel = 0;
      for (const q of slice.quotes) {
        const wHat = w(q.logMoneyness, result.params);
        const ivHat = varianceToIv(wHat, T);
        const rel = Math.abs(ivHat - q.impliedVol) / q.impliedVol;
        if (rel > maxRel) maxRel = rel;
      }
      expect(maxRel).toBeLessThan(5e-3);
    }
  });
});

describe("fitSviSlice — invalid input handling", () => {
  it("rejects non-positive timeToExpiry", () => {
    const result = fitSviSlice({
      quotes: [
        { logMoneyness: 0, impliedVol: 0.2 },
        { logMoneyness: 0.1, impliedVol: 0.21 },
        { logMoneyness: 0.2, impliedVol: 0.22 },
      ],
      timeToExpiry: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-input");
      expect(result.details.field).toBe("timeToExpiry");
    }
  });

  it("rejects under-determined slice (< 3 quotes)", () => {
    const result = fitSviSlice({
      quotes: [
        { logMoneyness: 0, impliedVol: 0.2 },
        { logMoneyness: 0.1, impliedVol: 0.21 },
      ],
      timeToExpiry: 0.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("underdetermined");
  });

  it("rejects NaN log-moneyness with reason invalid-input", () => {
    const result = fitSviSlice({
      quotes: [
        { logMoneyness: Number.NaN, impliedVol: 0.2 },
        { logMoneyness: 0, impliedVol: 0.21 },
        { logMoneyness: 0.1, impliedVol: 0.22 },
      ],
      timeToExpiry: 0.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-input");
      expect(result.details.field).toBe("logMoneyness");
    }
  });

  it("rejects non-positive impliedVol", () => {
    const result = fitSviSlice({
      quotes: [
        { logMoneyness: 0, impliedVol: 0.2 },
        { logMoneyness: 0.1, impliedVol: -0.1 },
        { logMoneyness: 0.2, impliedVol: 0.22 },
      ],
      timeToExpiry: 0.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-input");
      expect(result.details.field).toBe("impliedVol");
    }
  });

  it("rejects non-positive weight", () => {
    const result = fitSviSlice({
      quotes: [
        { logMoneyness: 0, impliedVol: 0.2, weight: 0 },
        { logMoneyness: 0.1, impliedVol: 0.21 },
        { logMoneyness: 0.2, impliedVol: 0.22 },
      ],
      timeToExpiry: 0.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-input");
  });
});
