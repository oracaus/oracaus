import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fitSviSlice } from "../src/svi/fitter.js";
import type { Slice } from "../src/svi/svi.js";

type GatheralFixture = {
  truth: { a: number; b: number; rho: number; m: number; sigma: number };
  timeToExpiry: number;
  quotes: ReadonlyArray<{ logMoneyness: number; impliedVol: number }>;
};

type ScipyReference = {
  params: { a: number; b: number; rho: number; m: number; sigma: number };
};

const FIXTURES = join(__dirname, "fixtures");

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

const PER_PARAM_TOLERANCE = {
  a: 1e-4,
  b: 1e-3,
  rho: 1e-3,
  m: 1e-3,
  sigma: 1e-4,
} as const;

// Each catalog entry pairs a synthetic Gatheral fixture with the scipy
// reference for that fixture. Adding a regime: drop a `gatheral-X.json`
// in `test/fixtures/`, run `python3 demo/tools/generate-scipy-reference.py`
// to produce `scipy-reference-X.json`, and add an entry below.
const CATALOG = [
  {
    label: "SPX-style (rho = -0.5)",
    fixture: "gatheral-spx.json",
    scipy: "scipy-reference.json",
  },
  {
    label: "strongly skewed (rho = -0.85)",
    fixture: "gatheral-skewed.json",
    scipy: "scipy-reference-skewed.json",
  },
] as const;

describe.each(CATALOG)("SVI cross-validation — $label", ({
  fixture,
  scipy: scipyPath,
}) => {
  const gatheral = loadJson<GatheralFixture>(fixture);
  const scipy = loadJson<ScipyReference>(scipyPath);

  const slice: Slice = {
    quotes: gatheral.quotes,
    timeToExpiry: gatheral.timeToExpiry,
  };

  it("our fitter recovers truth params within per-param tolerance", () => {
    const result = fitSviSlice(slice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const p = result.params;
      expect(Math.abs(p.a - gatheral.truth.a)).toBeLessThan(
        PER_PARAM_TOLERANCE.a,
      );
      expect(Math.abs(p.b - gatheral.truth.b)).toBeLessThan(
        PER_PARAM_TOLERANCE.b,
      );
      expect(Math.abs(p.rho - gatheral.truth.rho)).toBeLessThan(
        PER_PARAM_TOLERANCE.rho,
      );
      expect(Math.abs(p.m - gatheral.truth.m)).toBeLessThan(
        PER_PARAM_TOLERANCE.m,
      );
      expect(Math.abs(p.sigma - gatheral.truth.sigma)).toBeLessThan(
        PER_PARAM_TOLERANCE.sigma,
      );
    }
  });

  it("our fitter agrees with scipy.optimize.least_squares within per-param tolerance", () => {
    const result = fitSviSlice(slice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const p = result.params;
      expect(Math.abs(p.a - scipy.params.a)).toBeLessThan(
        PER_PARAM_TOLERANCE.a,
      );
      expect(Math.abs(p.b - scipy.params.b)).toBeLessThan(
        PER_PARAM_TOLERANCE.b,
      );
      expect(Math.abs(p.rho - scipy.params.rho)).toBeLessThan(
        PER_PARAM_TOLERANCE.rho,
      );
      expect(Math.abs(p.m - scipy.params.m)).toBeLessThan(
        PER_PARAM_TOLERANCE.m,
      );
      expect(Math.abs(p.sigma - scipy.params.sigma)).toBeLessThan(
        PER_PARAM_TOLERANCE.sigma,
      );
    }
  });

  it("scipy reference and truth agree to ≈Float64 precision (sanity check)", () => {
    // For noiseless data, scipy's TRF should converge to truth at ≈10⁻¹⁵
    // relative. The 1e-13 threshold leaves ~2 ULP for solver-version drift.
    // If this fails after a `requirements.txt` bump, regenerate via
    // `demo/tools/generate-scipy-reference.py` and inspect before
    // loosening the threshold.
    expect(Math.abs(scipy.params.a - gatheral.truth.a)).toBeLessThan(1e-13);
    expect(Math.abs(scipy.params.b - gatheral.truth.b)).toBeLessThan(1e-13);
    expect(Math.abs(scipy.params.rho - gatheral.truth.rho)).toBeLessThan(1e-13);
    expect(Math.abs(scipy.params.m - gatheral.truth.m)).toBeLessThan(1e-13);
    expect(Math.abs(scipy.params.sigma - gatheral.truth.sigma)).toBeLessThan(
      1e-13,
    );
  });
});
