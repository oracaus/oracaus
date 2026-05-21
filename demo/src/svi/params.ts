// Raw-SVI parametric form parameters (Gatheral & Jacquier 2014, Section 3).
//
//   w(k) = a + b · (ρ · (k − m) + √((k − m)² + σ²))
//
// with k = log(K/F) the log-moneyness and w = IV² · T the total variance.
//
// Constraint set (Gatheral 2014, Eq. 3.1–3.3):
//   - b ≥ 0       (asymptotic slopes b·(1±ρ) non-negative)
//   - |ρ| ≤ 1     (otherwise asymptotic slopes diverge with opposite signs)
//   - σ > 0       (σ = 0 collapses w into a kinked piecewise-linear)
//   - level: a + b·σ·√(1 − ρ²) ≥ 0
//     ensures w(k) ≥ 0 globally; the minimum of w is attained at
//     k = m − ρ·σ/√(1 − ρ²).
//
// `SviParams` is branded — only `validateParams` produces one. Adopters
// cannot fabricate the brand, so an unvalidated parameter set cannot reach
// the fitter or the no-arb checks by accident.
//
// `validateParams` returns a discriminated union; no exceptions on expected
// failures (matches the library's overall error discipline).
//
// Numerical note: `1 − ρ²` is computed as `(1 − ρ)·(1 + ρ)` to avoid
// catastrophic cancellation as |ρ| → 1.

declare const SviParamsBrand: unique symbol;

export type RawSviParams = {
  readonly a: number;
  readonly b: number;
  readonly rho: number;
  readonly m: number;
  readonly sigma: number;
};

export type SviParams = RawSviParams & {
  readonly [SviParamsBrand]: typeof SviParamsBrand;
};

export type ValidationFailureReason =
  | "non-finite"
  | "negative-b"
  | "rho-out-of-range"
  | "non-positive-sigma"
  | "level-violation";

export type ValidationFailure = {
  readonly ok: false;
  readonly reason: ValidationFailureReason;
  readonly details: Readonly<Record<string, number | string>>;
};

export type ValidationSuccess = {
  readonly ok: true;
  readonly params: SviParams;
};

export type ValidationResult = ValidationSuccess | ValidationFailure;

const RAW_PARAM_NAMES = ["a", "b", "rho", "m", "sigma"] as const;

/**
 * Computes the level-constraint floor `−b·σ·√(1 − ρ²)`. The valid `a` set
 * is `a ≥ levelFloor(b, ρ, σ)`. Numerically stable for |ρ| → 1 via the
 * `(1 − ρ)·(1 + ρ)` factoring.
 *
 * Pre-condition: `b ≥ 0`, `σ > 0`, `|ρ| ≤ 1` (the caller in `validateParams`
 * checks these first; tiny negative results from rounding are clamped to 0).
 */
export function levelFloor(b: number, rho: number, sigma: number): number {
  const oneMinusRhoSq = (1 - rho) * (1 + rho);
  const safe = oneMinusRhoSq < 0 ? 0 : oneMinusRhoSq;
  return -b * sigma * Math.sqrt(safe);
}

/** Validates raw SVI parameters and brands them on success. */
export function validateParams(p: RawSviParams): ValidationResult {
  for (const name of RAW_PARAM_NAMES) {
    const value = p[name];
    if (!Number.isFinite(value)) {
      return {
        ok: false,
        reason: "non-finite",
        details: { param: name, value },
      };
    }
  }
  if (p.b < 0) {
    return { ok: false, reason: "negative-b", details: { b: p.b } };
  }
  if (p.rho < -1 || p.rho > 1) {
    return { ok: false, reason: "rho-out-of-range", details: { rho: p.rho } };
  }
  if (p.sigma <= 0) {
    return {
      ok: false,
      reason: "non-positive-sigma",
      details: { sigma: p.sigma },
    };
  }
  const floor = levelFloor(p.b, p.rho, p.sigma);
  if (p.a < floor) {
    return {
      ok: false,
      reason: "level-violation",
      details: { a: p.a, levelFloor: floor },
    };
  }
  return { ok: true, params: p as SviParams };
}
