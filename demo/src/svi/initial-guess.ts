// Zeliade-style initial guess for raw-SVI calibration. Reference: Zeliade
// Systems "Quasi-Explicit Calibration of Gatheral's SVI Model" (2009).
//
// The trick: for fixed (m, σ), the SVI form is linear in three derived
// parameters (α, β, γ) = (a, b·ρ, b):
//
//   w(k) = a · 1  +  (b·ρ) · (k − m)  +  b · √((k − m)² + σ²)
//        = α       +  β · (k − m)     +  γ · √((k − m)² + σ²)
//
// so the inner step is a 3-parameter linear least-squares with closed-form
// solution via the 3×3 normal equations. The outer step is a deterministic
// 2-D grid over (m, σ); for each (m, σ) candidate, run the inner LS,
// project the result onto the SVI feasible cone (γ ≥ MIN_B, |β| ≤ γ, level
// constraint a ≥ −b·σ·√(1 − ρ²)), and record the residual. The grid point
// with lowest residual after projection is the initial guess passed to the
// LM polish.
//
// The grid is deterministic (no RNG) — same inputs produce identical
// initial guesses across runs. If no grid point produces a feasible
// candidate (b ≥ MIN_B after cone projection), the routine returns
// `no-feasible-init`. Earlier versions had a "wider fallback grid" pass;
// it is removed because, with the upstream unique-k rank check in the
// fitter and a sensibly-sized main grid, the inner LS is solvable at
// every candidate (it never returns null) — fallback was dead code. If
// every candidate fails the b-floor projection, the slice is genuinely
// degenerate (e.g. constant w) and a wider grid would not help.

import type { RawSviParams, SviParams } from "./params.js";
import { validateParams } from "./params.js";
import { w } from "./svi.js";

export type InitialGuessSuccess = {
  readonly ok: true;
  readonly params: SviParams;
  readonly residualNorm: number;
};

export type InitialGuessFailure = {
  readonly ok: false;
  readonly reason: "no-feasible-init" | "underdetermined";
  readonly details: Readonly<Record<string, number>>;
};

export type InitialGuessResult = InitialGuessSuccess | InitialGuessFailure;

type Grid = {
  readonly mMin: number;
  readonly mMax: number;
  readonly mStep: number;
  readonly sigmaMin: number;
  readonly sigmaMax: number;
  readonly sigmaSteps: number;
};

// Main grid: ranges chosen for typical equity-option calibration where
// log-moneyness is roughly in [−0.5, 0.5] and the smoother σ is in
// [0.01, 1.0]. Step sizes (Δm = 0.05; 12 log-spaced σ) keep the candidate
// count modest (231) while covering the parameter manifold densely enough
// for the 5 %-accuracy criterion.
const MAIN_GRID: Grid = {
  mMin: -0.5,
  mMax: 0.5,
  mStep: 0.05,
  sigmaMin: 0.01,
  sigmaMax: 1.0,
  sigmaSteps: 12,
};

const MIN_QUOTES = 3;

// Floor on the projected b after cone clamp. Without it, a candidate with
// γ ≈ 0 produces an `SviParams` where b = 0; the LM then enters
// reparametrised space at b̃ = invSoftplus(0) = −∞, the chain factor
// (1 − e⁻ᵇ) = 0, and the LM cannot move b away from zero. The fitter
// silently returns a constant-w fit. Floor at 1e-3 (well below realistic
// SVI b ∈ [0.01, 1]; tighter and adopters lose information at very-flat
// surfaces; looser and we over-clamp legitimate near-zero-skew slices).
const MIN_B = 1e-3;

export function initialGuess(
  ks: readonly number[],
  ws: readonly number[],
  weights?: readonly number[],
): InitialGuessResult {
  if (ks.length !== ws.length) {
    throw new Error(
      `initialGuess: ks.length (${ks.length}) ≠ ws.length (${ws.length})`,
    );
  }
  if (ks.length < MIN_QUOTES) {
    return {
      ok: false,
      reason: "underdetermined",
      details: { quoteCount: ks.length, minRequired: MIN_QUOTES },
    };
  }
  const W = weights ?? ks.map(() => 1);

  const best = scanGrid(ks, ws, W, MAIN_GRID);
  if (best !== null) {
    return {
      ok: true,
      params: best.params,
      residualNorm: Math.sqrt(best.residualSq),
    };
  }
  return {
    ok: false,
    reason: "no-feasible-init",
    details: { quoteCount: ks.length },
  };
}

type Candidate = { residualSq: number; params: SviParams };

function scanGrid(
  ks: readonly number[],
  ws: readonly number[],
  weights: readonly number[],
  grid: Grid,
): Candidate | null {
  let best: Candidate | null = null;
  const nM = Math.floor((grid.mMax - grid.mMin) / grid.mStep) + 1;
  const sigmaLogMin = Math.log(grid.sigmaMin);
  const sigmaLogMax = Math.log(grid.sigmaMax);
  const sigmaLogStep =
    (sigmaLogMax - sigmaLogMin) / Math.max(1, grid.sigmaSteps - 1);

  for (let im = 0; im < nM; im++) {
    const m = grid.mMin + im * grid.mStep;
    for (let is = 0; is < grid.sigmaSteps; is++) {
      const sigma = Math.exp(sigmaLogMin + is * sigmaLogStep);
      const candidate = innerFit(ks, ws, weights, m, sigma);
      if (candidate === null) continue;
      if (best === null || candidate.residualSq < best.residualSq) {
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * Closed-form linear LS for fixed (m, σ): solves the 3×3 weighted normal
 * equations for (α, β, γ), projects onto the SVI feasible cone, and
 * returns the post-projection candidate plus its weighted residual.
 */
function innerFit(
  ks: readonly number[],
  ws: readonly number[],
  weights: readonly number[],
  m: number,
  sigma: number,
): Candidate | null {
  let s11 = 0;
  let s12 = 0;
  let s13 = 0;
  let s22 = 0;
  let s23 = 0;
  let s33 = 0;
  let r1 = 0;
  let r2 = 0;
  let r3 = 0;
  const N = ks.length;
  for (let i = 0; i < N; i++) {
    const k = ks[i] ?? 0;
    const wgt = weights[i] ?? 1;
    const km = k - m;
    // Inline √(km² + σ²) — see jacobian.ts for the hypot/sqrt rationale.
    const sq = Math.sqrt(km * km + sigma * sigma);
    const x1 = 1;
    const x2 = km;
    const x3 = sq;
    const yi = ws[i] ?? 0;
    s11 += wgt * x1 * x1;
    s12 += wgt * x1 * x2;
    s13 += wgt * x1 * x3;
    s22 += wgt * x2 * x2;
    s23 += wgt * x2 * x3;
    s33 += wgt * x3 * x3;
    r1 += wgt * x1 * yi;
    r2 += wgt * x2 * yi;
    r3 += wgt * x3 * yi;
  }
  const theta = solve3x3Symmetric(s11, s12, s13, s22, s23, s33, r1, r2, r3);
  if (theta === null) return null;
  const [alpha, beta, gamma] = theta;

  // Project onto the SVI feasible cone: γ ≥ MIN_B, |β| ≤ γ. Below the
  // b-floor, this candidate is rejected — see `MIN_B` rationale above.
  if (gamma < MIN_B) return null;
  const gammaP = gamma;
  let betaP = beta;
  if (Math.abs(betaP) > gammaP) {
    // Clamp ρ to (−1, 1) — strict so the LM polish doesn't immediately
    // hit the boundary in reparametrised space.
    const sign = betaP > 0 ? 1 : -1;
    betaP = sign * gammaP * 0.999;
  }
  const rhoP = betaP / gammaP;

  // Level-floor projection: ensure a + b·σ·√(1 − ρ²) ≥ 0.
  const oneMinusRhoSq = (1 - rhoP) * (1 + rhoP);
  const safeOmr = oneMinusRhoSq < 0 ? 0 : oneMinusRhoSq;
  const floor = -gammaP * sigma * Math.sqrt(safeOmr);
  const aP = alpha < floor ? floor : alpha;

  // σ in the inner LS is fixed by the outer grid; bump tiny σ slightly off
  // zero to keep validateParams happy (σ > 0 strict).
  const sigmaP = sigma > 1e-8 ? sigma : 1e-8;

  const raw: RawSviParams = {
    a: aP,
    b: gammaP,
    rho: rhoP,
    m,
    sigma: sigmaP,
  };
  const validated = validateParams(raw);
  if (!validated.ok) return null;
  const params = validated.params;

  let rss = 0;
  for (let i = 0; i < N; i++) {
    const ki = ks[i] ?? 0;
    const wi = weights[i] ?? 1;
    const yi = ws[i] ?? 0;
    const e = w(ki, params) - yi;
    rss += wi * e * e;
  }
  return { residualSq: rss, params };
}

/**
 * Solves the 3×3 symmetric system
 *
 *     | s11 s12 s13 | |x|   |r1|
 *     | s12 s22 s23 | |y| = |r2|
 *     | s13 s23 s33 | |z|   |r3|
 *
 * via Cramer's rule. The matrix is symmetric (and PSD when constructed as
 * Jᵀ J) but the routine itself is general; it doesn't exploit the SPD
 * structure. A tiny ridge λ = 1e-14·max(diag) keeps the solve
 * well-conditioned on near-rank-deficient designs. Returns `null` if the
 * determinant remains vanishingly small after the ridge.
 */
function solve3x3Symmetric(
  s11: number,
  s12: number,
  s13: number,
  s22: number,
  s23: number,
  s33: number,
  r1: number,
  r2: number,
  r3: number,
): readonly [number, number, number] | null {
  const ridge = 1e-14 * Math.max(s11, s22, s33);
  const a = s11 + ridge;
  const e = s22 + ridge;
  const i = s33 + ridge;
  const b = s12;
  const c = s13;
  const f = s23;
  const cof11 = e * i - f * f;
  const cof12 = b * i - f * c;
  const cof13 = b * f - e * c;
  const det = a * cof11 - b * cof12 + c * cof13;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const cof21 = b * i - c * f;
  const cof22 = a * i - c * c;
  const cof23 = a * f - b * c;
  const cof31 = b * f - c * e;
  const cof32 = a * f - b * c;
  const cof33 = a * e - b * b;
  const x = (cof11 * r1 - cof21 * r2 + cof31 * r3) / det;
  const y = (-cof12 * r1 + cof22 * r2 - cof32 * r3) / det;
  const z = (cof13 * r1 - cof23 * r2 + cof33 * r3) / det;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return [x, y, z];
}
