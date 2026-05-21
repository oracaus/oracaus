// Reparametrisation between constrained raw SVI parameters and the
// unconstrained R⁵ space the LM solver operates in. Following the standard
// constrained-to-unconstrained transform pattern used in nonlinear LS
// pipelines (see Madsen, Nielsen & Tingleff 2004, §3.4 on handling bound
// constraints via smooth reparametrisation rather than active-set / KKT):
//
//   b      = softplus(b̃)    so b ≥ 0           ∂b/∂b̃    = 1 − e^{−b}
//   ρ      = tanh(ρ̃)        so |ρ| < 1         ∂ρ/∂ρ̃    = 1 − ρ²
//   σ      = softplus(σ̃)    so σ > 0           ∂σ/∂σ̃    = 1 − e^{−σ}
//
// `a` and `m` need no transform (unconstrained on R; the level coupling
// `a + b·σ·√(1 − ρ²) ≥ 0` is enforced as a soft penalty in the LM cost,
// not as a per-parameter bound).
//
// Reparametrising rather than clipping eliminates a documented source of
// bias as |ρ| → 1: clipping makes the cost surface non-smooth at the bound
// and the LM update can stall against it; tanh keeps the surface smooth
// and pushes the bound to ±∞ in unconstrained space.
//
// All three derivative identities are expressed in terms of the constrained
// parameter (b, ρ, σ) rather than the unconstrained (b̃, ρ̃, σ̃). This is
// algebraically equivalent and numerically cleaner — `1 − e^{−b}` is well
// defined for any b ≥ 0, but `e^{b̃} / (1 + e^{b̃})` overflows for large b̃.

import type { RawSviParams } from "./params.js";

/**
 * Numerically stable softplus: `log(1 + e^x)`. Branches on the sign of `x`
 * to avoid overflow for large positive x and underflow for large negative x.
 */
export function softplus(x: number): number {
  if (x > 0) return x + Math.log1p(Math.exp(-x));
  return Math.log1p(Math.exp(x));
}

/**
 * Inverse softplus: `log(e^y − 1)` for y > 0. Reduces to `log(expm1(y))`
 * which is stable for small y; for large y it tends to y.
 */
export function invSoftplus(y: number): number {
  if (y <= 0) return Number.NEGATIVE_INFINITY;
  if (y > 30) return y;
  return Math.log(Math.expm1(y));
}

/** Numerically stable sigmoid: `1 / (1 + e^{−x})`. */
export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** Unconstrained reparametrisation of SVI parameters; lives on R⁵. */
export type ReparamSviParams = {
  readonly a: number;
  readonly bTilde: number;
  readonly rhoTilde: number;
  readonly m: number;
  readonly sigmaTilde: number;
};

/** Map unconstrained → constrained (raw) parameters. */
export function fromReparam(u: ReparamSviParams): RawSviParams {
  return {
    a: u.a,
    b: softplus(u.bTilde),
    rho: Math.tanh(u.rhoTilde),
    m: u.m,
    sigma: softplus(u.sigmaTilde),
  };
}

/**
 * Map constrained → unconstrained. Requires `b > 0`, `σ > 0`, `|ρ| < 1` —
 * the bounds are open in unconstrained space (`atanh(±1) = ±∞`,
 * `invSoftplus(0) = −∞`). Callers should clamp ρ slightly off ±1 (e.g.
 * `min(max(ρ, -1 + ε), 1 - ε)`) before invoking.
 */
export function toReparam(p: RawSviParams): ReparamSviParams {
  return {
    a: p.a,
    bTilde: invSoftplus(p.b),
    rhoTilde: Math.atanh(p.rho),
    m: p.m,
    sigmaTilde: invSoftplus(p.sigma),
  };
}
