// Per-point SVI diagnostics for the hover overlay (Smile + OptionChainTable).
//
// Not a library primitive — demo-internal. Three numbers a vol trader wants
// when reading a smile at a chosen log-moneyness:
//
//   - dw/dk    : local skew (variance slope in k)
//   - d²w/dk²  : local convexity (smile curvature)
//   - g(k)     : Gatheral butterfly-arbitrage indicator (already in no-arb.ts;
//                re-exported here for one-import overlay code)
//
// Raw-SVI form:
//
//   w(k) = a + b · (ρ·(k − m) + h)        where h = √((k − m)² + σ²)
//
// Differentiating once and twice in k:
//
//   w'(k)  = b · (ρ + (k − m)/h)
//   w''(k) = b · σ² / h³
//
// Both expressions are smooth on R; the `h ≥ σ > 0` lower bound keeps the
// divisions safe under all feasible `SviParams` (`σ > 0` is a constraint).
// `Math.hypot(km, σ)` guards against intermediate overflow at extreme `|k − m|`,
// matching the convention in `svi.ts`.
//
// The overlay only consumes these at one k per render; cost is negligible.

import type { SviParams } from "./params.js";

export { gatheralG } from "./no-arb.js";

export type KDerivatives = {
  /** First derivative of total variance with respect to log-moneyness. */
  readonly dwdk: number;
  /** Second derivative of total variance with respect to log-moneyness. */
  readonly d2wdk2: number;
};

/** Analytical k-derivatives of raw-SVI total variance at log-moneyness `k`. */
export function kDerivatives(k: number, p: SviParams): KDerivatives {
  const km = k - p.m;
  const h = Math.hypot(km, p.sigma);
  const dwdk = p.b * (p.rho + km / h);
  const d2wdk2 = (p.b * p.sigma * p.sigma) / (h * h * h);
  return { dwdk, d2wdk2 };
}
