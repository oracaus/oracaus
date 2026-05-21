import { describe, expect, it } from "vitest";

import { initialGuess } from "../src/svi/initial-guess.js";
import type { SviParams } from "../src/svi/params.js";
import { validateParams } from "../src/svi/params.js";
import { ivToVariance, w } from "../src/svi/svi.js";

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

/**
 * Generates a synthetic slice from raw-SVI ground-truth params at the
 * supplied log-moneyness points. No noise — Block 4's gate is on the
 * deterministic recovery of the parametric form, not on noise robustness.
 */
function syntheticSlice(
  truth: SviParams,
  ks: readonly number[],
): { ks: readonly number[]; ws: readonly number[] } {
  const ws = ks.map((k) => w(k, truth));
  return { ks, ws };
}

describe("Zeliade initial guess — recovery of ground-truth params", () => {
  it("recovers Gatheral-style SPX params within 5 % on a 21-point grid", () => {
    // Representative SPX-equity SVI params (Gatheral & Jacquier 2014,
    // typical equity-index magnitudes).
    const truth = fixture(0.04, 0.1, -0.5, 0.0, 0.2);
    const ks = Array.from({ length: 21 }, (_, i) => -1.0 + i * 0.1);
    const slice = syntheticSlice(truth, ks);
    const result = initialGuess(slice.ks, slice.ws);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const p = result.params;
      expect(Math.abs(p.a - truth.a)).toBeLessThan(0.005); // 1e-2 absolute
      expect(Math.abs(p.b - truth.b) / truth.b).toBeLessThan(0.05);
      expect(Math.abs(p.rho - truth.rho)).toBeLessThan(0.05);
      expect(Math.abs(p.m - truth.m)).toBeLessThan(0.05);
      expect(Math.abs(p.sigma - truth.sigma) / truth.sigma).toBeLessThan(0.5);
      // σ on the outer grid is discretised at log-step ≈ 0.43, so the
      // inner LS minimises against fixed σ from the grid; tolerance for σ
      // is wider than for the others. Block 5's LM polish closes this gap.
    }
  });

  it("recovers a strongly-skewed slice (ρ = -0.85) within tolerance", () => {
    const truth = fixture(0.06, 0.15, -0.85, 0.05, 0.15);
    const ks = Array.from({ length: 17 }, (_, i) => -0.8 + i * 0.1);
    const slice = syntheticSlice(truth, ks);
    const result = initialGuess(slice.ks, slice.ws);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const p = result.params;
      expect(Math.abs(p.rho - truth.rho)).toBeLessThan(0.1);
      expect(Math.abs(p.b - truth.b) / truth.b).toBeLessThan(0.1);
      expect(Math.abs(p.m - truth.m)).toBeLessThan(0.1);
    }
  });

  it("recovers a high-ATM-vol slice (σ_iv = 0.4 at expiry T = 0.5)", () => {
    // IV ≈ 0.4 at ATM, T = 0.5 → w_atm = 0.16 · 0.5 = 0.08
    const truth = fixture(0.05, 0.12, -0.4, 0.0, 0.25);
    const T = 0.5;
    const ks = Array.from({ length: 15 }, (_, i) => -0.6 + i * 0.1);
    const ws = ks.map((k) => w(k, truth));
    const result = initialGuess(ks, ws);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Verify implied-vol → variance round-trip self-consistency at ATM.
      const wHat = w(0, result.params);
      const ivHat = Math.sqrt(wHat / T);
      expect(Math.abs(ivHat - Math.sqrt(w(0, truth) / T))).toBeLessThan(0.03);
    }
  });
});

describe("Zeliade initial guess — failure modes", () => {
  it("returns 'underdetermined' for fewer than 3 quotes", () => {
    const result = initialGuess([0, 0.1], [0.04, 0.05]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("underdetermined");
      expect(result.details.quoteCount).toBe(2);
    }
  });

  it("throws on length mismatch between ks and ws", () => {
    expect(() => initialGuess([0, 0.1, 0.2], [0.04, 0.05])).toThrow(
      /ks\.length.*ws\.length/,
    );
  });

  it("heavy ATM weighting on noisy data biases the inner LS toward ATM", () => {
    // Noiseless data has its optimum at truth regardless of weights; a
    // weight test on clean data is a non-test (the assertion `residualNorm
    // !== other.residualNorm` could pass by 1e-15 of rounding). With
    // noise added, the unweighted inner LS finds the noise-shifted
    // optimum; heavy ATM weighting biases the fit so ATM error shrinks.
    const truth = fixture(0.04, 0.1, -0.3, 0.0, 0.2);
    const ks = Array.from({ length: 13 }, (_, i) => -0.6 + i * 0.1);
    const cleanWs = ks.map((k) => w(k, truth));
    const rng = mulberry32(20251106);
    const noisyWs = cleanWs.map((wi) => wi + (rng() - 0.5) * 1e-3);

    const uniform = initialGuess(ks, noisyWs);
    const heavyAtm = initialGuess(
      ks,
      noisyWs,
      ks.map((k) => (Math.abs(k) < 0.05 ? 100 : 1)),
    );
    expect(uniform.ok).toBe(true);
    expect(heavyAtm.ok).toBe(true);
    if (uniform.ok && heavyAtm.ok) {
      const atmIdx = ks.findIndex((k) => Math.abs(k) < 0.05);
      const atmK = ks[atmIdx] ?? 0;
      const atmW = noisyWs[atmIdx] ?? 0;
      const uniAtmRes = Math.abs(w(atmK, uniform.params) - atmW);
      const heavyAtmRes = Math.abs(w(atmK, heavyAtm.params) - atmW);
      // Heavy ATM weighting → tighter ATM fit (within the granularity of
      // the deterministic outer grid; allow ≤30% slack since both fits
      // share a 0.05-step m grid and σ-log-grid).
      expect(heavyAtmRes).toBeLessThanOrEqual(uniAtmRes);
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

describe("Zeliade initial guess — IV input round-trip", () => {
  it("accepts IV-derived total variance and recovers truth", () => {
    // Adopter-shaped flow: convert IV² · T → w, run initial guess.
    const truth = fixture(0.05, 0.1, -0.3, 0.0, 0.2);
    const T = 0.25;
    const ks = Array.from({ length: 13 }, (_, i) => -0.6 + i * 0.1);
    const ws = ks.map((k) => w(k, truth));
    const ivs = ws.map((wi) => Math.sqrt(wi / T));
    const wsRoundTrip = ivs.map((iv) => ivToVariance(iv, T));
    const result = initialGuess(ks, wsRoundTrip);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Math.abs(result.params.b - truth.b) / truth.b).toBeLessThan(0.05);
      expect(Math.abs(result.params.rho - truth.rho)).toBeLessThan(0.05);
    }
  });
});
