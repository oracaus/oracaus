// Analytical partials of `w(k; params)` with respect to each SVI parameter.
//
//   w(k) = a + b·(ρ·(k−m) + r),   r = √((k−m)² + σ²)
//
// Raw partials (Gatheral & Jacquier 2014, derived):
//   ∂w/∂a = 1
//   ∂w/∂b = ρ·(k−m) + r
//   ∂w/∂ρ = b·(k−m)
//   ∂w/∂m = −b·(ρ + (k−m)/r)
//   ∂w/∂σ = b·σ/r
//
// Reparametrised partials apply the chain rule with the multipliers from
// `reparam.ts`:
//   ∂w/∂b̃     = (∂w/∂b) · (1 − e^{−b})
//   ∂w/∂ρ̃     = (∂w/∂ρ) · (1 − ρ²)        // 1 − ρ² = (1 − ρ)·(1 + ρ)
//   ∂w/∂σ̃     = (∂w/∂σ) · (1 − e^{−σ})
//   ∂w/∂a, ∂w/∂m unchanged
//
// The functions accept `RawSviParams` rather than the branded `SviParams`:
// the math depends only on the structural numeric fields, and the LM
// inner loop calls these on intermediate iterates that are by design
// pre-validation. Validation gates `validateParams`, not the partials.
//
// `r` is the SVI smoother and never zero under validated inputs (σ > 0).
// We use explicit `√(km² + σ²)` rather than `Math.hypot` — hypot is
// overflow-safe but ≈20× slower on V8. The fitter calls these partials
// with `km` and `σ` bounded in O(1) via reparametrisation, so overflow
// is impossible (max km² + σ² is ≈30 for realistic SVI calibrations).
// Adopters evaluating `svi.ts:w()` directly at extreme `|k|` get hypot's
// overflow guard there. Field names are prefixed with `d` ("derivative
// wrt …") to disambiguate from raw parameter values of the same name.

import type { RawSviParams } from "./params.js";

export type RawPartials = {
  /** ∂w/∂a — identically 1. */
  readonly da: number;
  /** ∂w/∂b — `ρ·(k − m) + √((k − m)² + σ²)`. */
  readonly db: number;
  /** ∂w/∂ρ — `b·(k − m)`. */
  readonly dRho: number;
  /** ∂w/∂m — `−b·(ρ + (k − m)/r)`. */
  readonly dm: number;
  /** ∂w/∂σ — `b·σ / r`. */
  readonly dSigma: number;
};

export type ReparamPartials = {
  /** ∂w/∂a (unchanged from raw). */
  readonly da: number;
  /** ∂w/∂b̃ = ∂w/∂b · (1 − e^{−b}). */
  readonly dbTilde: number;
  /** ∂w/∂ρ̃ = ∂w/∂ρ · (1 − ρ²). */
  readonly dRhoTilde: number;
  /** ∂w/∂m (unchanged from raw). */
  readonly dm: number;
  /** ∂w/∂σ̃ = ∂w/∂σ · (1 − e^{−σ}). */
  readonly dSigmaTilde: number;
};

/** All five raw-parameter partials at log-moneyness `k`. */
export function rawPartials(k: number, p: RawSviParams): RawPartials {
  const km = k - p.m;
  const r = Math.sqrt(km * km + p.sigma * p.sigma);
  return {
    da: 1,
    db: p.rho * km + r,
    dRho: p.b * km,
    dm: -p.b * (p.rho + km / r),
    dSigma: (p.b * p.sigma) / r,
  };
}

/** Reparametrised partials — chain rule applied to `rawPartials`. */
export function reparamPartials(k: number, p: RawSviParams): ReparamPartials {
  const raw = rawPartials(k, p);
  const dbDbTilde = 1 - Math.exp(-p.b);
  const dRhoDRhoTilde = (1 - p.rho) * (1 + p.rho);
  const dSigmaDSigmaTilde = 1 - Math.exp(-p.sigma);
  return {
    da: raw.da,
    dbTilde: raw.db * dbDbTilde,
    dRhoTilde: raw.dRho * dRhoDRhoTilde,
    dm: raw.dm,
    dSigmaTilde: raw.dSigma * dSigmaDSigmaTilde,
  };
}
