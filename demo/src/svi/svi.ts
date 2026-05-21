// SVI total-variance evaluation w(k, params) and slice utilities.
//
// Reference: Gatheral & Jacquier, "Arbitrage-free SVI volatility surfaces"
// (Quantitative Finance 14:1, 2014), Section 3 — raw-SVI parametric form:
//
//   w(k) = a + b · (ρ·(k − m) + √((k − m)² + σ²))
//
// where k = log(K/F) is log-moneyness and w = IV² · T is total variance.
//
// The form is C¹ everywhere on R; ∂w/∂σ has a localised spike at k = m
// (the smoothing parameter governs the transition between the two linear
// asymptotes). `Math.hypot(km, σ)` guards against intermediate overflow at
// large |k − m|.

import type { SviParams } from "./params.js";

/** Total variance at log-moneyness `k` under the raw-SVI parametric form. */
export function w(k: number, params: SviParams): number {
  const km = k - params.m;
  return params.a + params.b * (params.rho * km + Math.hypot(km, params.sigma));
}

/** A single calibration quote on a slice. */
export type Quote = {
  /** Log-moneyness `log(K / F)`. */
  readonly logMoneyness: number;
  /** Implied vol (annualised, decimal). */
  readonly impliedVol: number;
  /**
   * Optional weight for weighted least-squares. Defaults to uniform (1.0).
   * Adopters supply e.g. `1 / (bid − ask)²` to down-weight loose quotes.
   */
  readonly weight?: number;
};

/** A single calibration slice — quotes sharing one maturity. */
export type Slice = {
  readonly quotes: readonly Quote[];
  /** Time to expiry in years. */
  readonly timeToExpiry: number;
};

/** Implied vol → total variance: `w = IV² · T`. */
export function ivToVariance(iv: number, timeToExpiry: number): number {
  return iv * iv * timeToExpiry;
}

/** Total variance → implied vol: `IV = √(w / T)`. */
export function varianceToIv(
  totalVariance: number,
  timeToExpiry: number,
): number {
  return Math.sqrt(totalVariance / timeToExpiry);
}
