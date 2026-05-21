// Composed SVI calibration: input validation → IV→variance → Zeliade init
// guess → LM polish in reparametrised space → back-transform → result.
//
// Per-slice raw-SVI form (Gatheral & Jacquier 2014, Section 3) with the
// constraint set enforced by Zeliade Systems 2009 (initial guess) + smooth
// reparametrisation (`reparam.ts`) + Madsen, Nielsen & Tingleff 2004 (LM).
//
// LM polish operates on the unconstrained vector u = (a, b̃, ρ̃, m, σ̃)
// with `b = softplus(b̃)`, `ρ = tanh(ρ̃)`, `σ = softplus(σ̃)` (see
// `reparam.ts`). The level coupling `a + b·σ·√(1 − ρ²) ≥ 0` doesn't
// decompose into per-parameter bounds, so it's enforced as a one-sided
// soft quadratic penalty appended to the residual vector — the LM treats
// it as just another residual row. The penalty weight defaults to 1.0
// and adopters can override.
//
// The Jacobian for the penalty row is derived analytically (chain rule
// for the reparametrised variables); when the constraint is satisfied,
// the row is zeroed.
//
// Failure modes (no exceptions):
//   - "invalid-input" — non-finite / non-positive T, IV, k, weight, etc.
//   - "underdetermined" — too few quotes for a 5-param fit (< 3)
//   - "no-convergence" — Zeliade no-feasible-init OR LM hit iteration cap
//   - "constraint-violation" — final params fail validation post-back-transform
//   - "numerical-failure" — non-finite residual / Jacobian / linear-solve

import { initialGuess } from "./initial-guess.js";
import { reparamPartials } from "./jacobian.js";
import {
  type LmOptions,
  type LmResult,
  levenbergMarquardt,
} from "./lm-solver.js";
import { type RawSviParams, type SviParams, validateParams } from "./params.js";
import { fromReparam, type ReparamSviParams, toReparam } from "./reparam.js";
import type { Quote, Slice } from "./svi.js";
import { ivToVariance } from "./svi.js";

/**
 * Discriminant of `FitFailure`. Variants:
 * - `"invalid-input"` — slice failed pre-flight: non-finite / non-positive
 *   `timeToExpiry`, `impliedVol`, `logMoneyness`, or `weight`. `details`
 *   names the offending field.
 * - `"underdetermined"` — fewer than 3 quotes, or fewer than 3 distinct
 *   log-moneyness values (rank-deficient inner LS regardless of count).
 *   5-param SVI fit needs at least 5 data residuals; 3 is the practical
 *   floor — below 3 the inner Zeliade LS is structurally degenerate.
 * - `"no-convergence"` — either Zeliade scan produced no feasible
 *   candidate (every grid point failed cone projection), or LM hit its
 *   `maxIterations` cap. `details.stage` distinguishes which.
 * - `"constraint-violation"` — LM converged but the back-transformed
 *   raw params fail `validateParams` (numerical drift through
 *   reparametrisation; vanishingly rare in practice).
 * - `"numerical-failure"` — non-finite residual / Jacobian, or
 *   linear-solve diverged (damping ran away past `MAX_DAMPING`). The LM
 *   has exhausted recovery options.
 */
export type FitFailureReason =
  | "invalid-input"
  | "underdetermined"
  | "no-convergence"
  | "constraint-violation"
  | "numerical-failure";

export type FitDiagnostics = {
  readonly reason: "gradient-tolerance" | "step-tolerance";
  readonly damping: number;
  readonly initialGuessResidualNorm: number;
  /**
   * Range of log-moneyness present in the input slice. The fitted SVI
   * surface is reliable only inside this range; SVI extrapolates outside
   * the calibrated `k` range and can produce arbitrage-violating IVs at
   * extreme strikes (Phase 2 hardening note). Adopters should clip
   * evaluation to `[kMin, kMax]` or surface a warning when querying
   * outside; `butterflyCheck` on an extended grid documents the
   * extrapolated regime.
   */
  readonly calibratedRange: { readonly kMin: number; readonly kMax: number };
};

/** Successful fit. `params` is branded — only `validateParams` mints it. */
export type FitSuccess = {
  readonly ok: true;
  readonly params: SviParams;
  readonly iterations: number;
  readonly residualNorm: number;
  readonly diagnostics: FitDiagnostics;
};

/**
 * Failed fit. `reason` discriminates the failure mode; `details` carries
 * mode-specific context (offending field, stage, last residual norm, etc.)
 * for diagnostics and adopter-side error surfacing.
 */
export type FitFailure = {
  readonly ok: false;
  readonly reason: FitFailureReason;
  readonly details: Readonly<Record<string, unknown>>;
};

/**
 * Discriminated union over fit outcomes. Narrow via `result.ok`. Never
 * throws on expected failure modes — all are encoded as `FitFailure`
 * variants. (Programmer errors — wrong array lengths in the caller — still
 * throw.)
 */
export type FitResult = FitSuccess | FitFailure;

export type FitOptions = {
  /**
   * Soft-penalty weight for the level constraint. The penalty residual
   * is `−L · violation` when `a + b·σ·√(1 − ρ²) < 0`, contributing
   * `(L · violation)²` to the SS. Default 1.0.
   *
   * Magnitude calibration: at the optimum on well-formed equity-option
   * data, the level constraint is interior (active violation = 0) so
   * this term is silent. When LM exploration crosses into violation,
   * `violation` is typically O(0.01); at L=1 the penalty residual matches
   * the magnitude of the violation, while individual data residuals are
   * O(1e-3) — so a violation of 0.01 contributes ≈100× the SS of a
   * single data residual, strong enough to push the LM back into the
   * feasible cone. Adopters who want stricter enforcement (e.g. fitting
   * on data where the optimum is near-boundary) can raise L; lower it
   * if the constraint is interfering with a legitimate fit.
   */
  readonly levelPenaltyWeight?: number;
  readonly lm?: LmOptions;
};

/**
 * Calendar-floor constraints used by `fitSviSliceWithCalendarFloor`.
 * `kPoints[j]` is a log-moneyness point at which the fitted slice must
 * satisfy `w(k_j, params) ≥ floorValues[j]`. Used by `repairCalendarArb`
 * (no-arb.ts) to enforce `w(k, T_current) ≥ w(k, T_prev)` at the specific
 * k-points where the prior calendarCheck detected a violation.
 */
export type CalendarFloorConstraints = {
  readonly kPoints: readonly number[];
  readonly floorValues: readonly number[];
};

export type CalendarFloorOptions = FitOptions & {
  /**
   * Soft-penalty weight for the calendar-floor residuals. Each floor
   * residual is `L · max(0, floor_j − w_hat_j)`; SS contribution is
   * `(L · violation)²` per violating k-point. Default 100.0 — calibrated
   * to be ~100× IV-residual scale. Data residuals
   * are O(1e-3); a floor violation of 1e-3 contributes ~1e-2 to SS, two
   * orders above per-data-point SS, strong enough to push the LM toward
   * the floor without overwhelming the calibration fit on benign points.
   */
  readonly calendarFloorWeight?: number;
};

const DEFAULT_LEVEL_PENALTY = 1.0;
const DEFAULT_CALENDAR_FLOOR_WEIGHT = 100.0;
const MIN_QUOTES = 3;

export function fitSviSlice(slice: Slice, options: FitOptions = {}): FitResult {
  return fitCore(slice, options, undefined);
}

/**
 * Like `fitSviSlice` but additionally enforces `w(k_j, params) ≥ floor_j`
 * at the supplied calendar-floor k-points via soft-penalty residuals.
 * Used by `repairCalendarArb` to re-fit a slice whose original fit
 * produced a calendar-arb violation against its predecessor in T.
 *
 * The base data and level-constraint residuals are unchanged from
 * `fitSviSlice`; the floor block is appended only when violating. If the
 * fit converges with all floor constraints satisfied, the result is
 * `ok` and indistinguishable from a normal fit (the same `FitResult`
 * shape — the floor block adds residual rows during LM iteration but
 * doesn't alter the success/failure-reason semantics).
 */
export function fitSviSliceWithCalendarFloor(
  slice: Slice,
  constraints: CalendarFloorConstraints,
  options: CalendarFloorOptions = {},
): FitResult {
  const floorCheck = validateFloorConstraints(constraints);
  if (!floorCheck.ok) return floorCheck;
  return fitCore(slice, options, constraints);
}

function fitCore(
  slice: Slice,
  options: CalendarFloorOptions,
  floor: CalendarFloorConstraints | undefined,
): FitResult {
  const inputCheck = validateSlice(slice);
  if (!inputCheck.ok) return inputCheck;

  const { ks, ws, weights } = unpackSlice(slice);

  const init = initialGuess(ks, ws, weights);
  if (!init.ok) {
    if (init.reason === "underdetermined") {
      return {
        ok: false,
        reason: "underdetermined",
        details: { ...init.details },
      };
    }
    return {
      ok: false,
      reason: "no-convergence",
      details: { stage: "initial-guess", ...init.details },
    };
  }

  const u0 = toReparam(init.params);
  const u0Arr: readonly number[] = [
    u0.a,
    u0.bTilde,
    u0.rhoTilde,
    u0.m,
    u0.sigmaTilde,
  ];

  const levelPenalty = options.levelPenaltyWeight ?? DEFAULT_LEVEL_PENALTY;
  const floorWeight =
    options.calendarFloorWeight ?? DEFAULT_CALENDAR_FLOOR_WEIGHT;
  const M = ks.length;
  const nFloor = floor?.kPoints.length ?? 0;
  const M_TOTAL = M + 1 + nFloor;
  const N = 5;
  const sqrtWeights = weights.map(Math.sqrt);

  const residual = (u: readonly number[]) =>
    computeResidual(
      u,
      ks,
      ws,
      sqrtWeights,
      M_TOTAL,
      levelPenalty,
      floor,
      floorWeight,
    );

  const jacobian = (u: readonly number[]) =>
    computeJacobian(
      u,
      ks,
      sqrtWeights,
      M_TOTAL,
      N,
      levelPenalty,
      floor,
      floorWeight,
    );

  const lm: LmResult = levenbergMarquardt(
    u0Arr,
    residual,
    jacobian,
    options.lm,
  );
  if (!lm.ok) {
    return {
      ok: false,
      reason:
        lm.reason === "max-iterations" ? "no-convergence" : "numerical-failure",
      details: {
        stage: "lm",
        lmReason: lm.reason,
        iterations: lm.iterations,
        lastResidualNorm: lm.residualNorm,
      },
    };
  }

  const finalU: ReparamSviParams = {
    a: lm.params[0] ?? 0,
    bTilde: lm.params[1] ?? 0,
    rhoTilde: lm.params[2] ?? 0,
    m: lm.params[3] ?? 0,
    sigmaTilde: lm.params[4] ?? 0,
  };
  const finalRaw: RawSviParams = {
    ...fromReparam(finalU),
    a: finalU.a,
  };
  const validated = validateParams(finalRaw);
  if (!validated.ok) {
    return {
      ok: false,
      reason: "constraint-violation",
      details: { ...validated.details, validationReason: validated.reason },
    };
  }

  let kMin = Number.POSITIVE_INFINITY;
  let kMax = Number.NEGATIVE_INFINITY;
  for (const k of ks) {
    if (k < kMin) kMin = k;
    if (k > kMax) kMax = k;
  }

  return {
    ok: true,
    params: validated.params,
    iterations: lm.iterations,
    residualNorm: lm.residualNorm,
    diagnostics: {
      reason: lm.reason,
      damping: lm.damping,
      initialGuessResidualNorm: init.residualNorm,
      calibratedRange: { kMin, kMax },
    },
  };
}

function validateFloorConstraints(
  c: CalendarFloorConstraints,
): FitFailure | { ok: true } {
  if (c.kPoints.length !== c.floorValues.length) {
    return {
      ok: false,
      reason: "invalid-input",
      details: {
        field: "floorConstraints",
        kPointsLength: c.kPoints.length,
        floorValuesLength: c.floorValues.length,
      },
    };
  }
  for (let j = 0; j < c.kPoints.length; j++) {
    const k = c.kPoints[j] as number;
    const f = c.floorValues[j] as number;
    if (!Number.isFinite(k)) {
      return {
        ok: false,
        reason: "invalid-input",
        details: { field: "floorConstraints.kPoints", index: j, value: k },
      };
    }
    if (!Number.isFinite(f)) {
      return {
        ok: false,
        reason: "invalid-input",
        details: { field: "floorConstraints.floorValues", index: j, value: f },
      };
    }
  }
  return { ok: true };
}

// ----- internal helpers -----

function validateSlice(slice: Slice): FitFailure | { ok: true } {
  if (!Number.isFinite(slice.timeToExpiry) || slice.timeToExpiry <= 0) {
    return {
      ok: false,
      reason: "invalid-input",
      details: {
        field: "timeToExpiry",
        value: slice.timeToExpiry,
      },
    };
  }
  if (slice.quotes.length < MIN_QUOTES) {
    return {
      ok: false,
      reason: "underdetermined",
      details: {
        quoteCount: slice.quotes.length,
        minRequired: MIN_QUOTES,
      },
    };
  }
  for (let i = 0; i < slice.quotes.length; i++) {
    const q = slice.quotes[i] as Quote;
    if (!Number.isFinite(q.logMoneyness)) {
      return {
        ok: false,
        reason: "invalid-input",
        details: { field: "logMoneyness", index: i, value: q.logMoneyness },
      };
    }
    if (!Number.isFinite(q.impliedVol) || q.impliedVol <= 0) {
      return {
        ok: false,
        reason: "invalid-input",
        details: { field: "impliedVol", index: i, value: q.impliedVol },
      };
    }
    if (q.weight !== undefined) {
      if (!Number.isFinite(q.weight) || q.weight <= 0) {
        return {
          ok: false,
          reason: "invalid-input",
          details: { field: "weight", index: i, value: q.weight },
        };
      }
    }
  }
  // Rank check on the design matrix: the inner LS columns are
  // [1, k − m, √((k − m)² + σ²)]; with fewer than 3 distinct log-moneyness
  // values these are linearly dependent and the 3-parameter inner solve
  // is rank-deficient. The 5-parameter SVI fit is correspondingly
  // under-determined regardless of total quote count. The ridge in
  // `solve3x3Spd` would still produce *some* answer, but it would be
  // arbitrary — fail fast instead.
  const uniqueK = new Set<number>();
  for (const q of slice.quotes) uniqueK.add(q.logMoneyness);
  if (uniqueK.size < 3) {
    return {
      ok: false,
      reason: "underdetermined",
      details: {
        uniqueLogMoneynessCount: uniqueK.size,
        minRequired: 3,
        totalQuotes: slice.quotes.length,
      },
    };
  }
  return { ok: true };
}

function unpackSlice(slice: Slice): {
  ks: number[];
  ws: number[];
  weights: number[];
} {
  const T = slice.timeToExpiry;
  const ks = slice.quotes.map((q) => q.logMoneyness);
  const ws = slice.quotes.map((q) => ivToVariance(q.impliedVol, T));
  const weights = slice.quotes.map((q) => q.weight ?? 1);
  return { ks, ws, weights };
}

function levelViolation(p: RawSviParams): number {
  const oneMinusRhoSq = (1 - p.rho) * (1 + p.rho);
  const safe = oneMinusRhoSq < 0 ? 0 : oneMinusRhoSq;
  return p.a + p.b * p.sigma * Math.sqrt(safe);
}

function unpackU(u: readonly number[]): ReparamSviParams {
  return {
    a: u[0] ?? 0,
    bTilde: u[1] ?? 0,
    rhoTilde: u[2] ?? 0,
    m: u[3] ?? 0,
    sigmaTilde: u[4] ?? 0,
  };
}

function unconstrainedRaw(u: readonly number[]): RawSviParams {
  const ru = unpackU(u);
  const r = fromReparam(ru);
  return { ...r, a: ru.a };
}

function computeResidual(
  u: readonly number[],
  ks: readonly number[],
  ws: readonly number[],
  sqrtWeights: readonly number[],
  M_TOTAL: number,
  levelPenalty: number,
  floor: CalendarFloorConstraints | undefined,
  floorWeight: number,
): Float64Array {
  const p = unconstrainedRaw(u);
  const r = new Float64Array(M_TOTAL);
  const M = ks.length;
  for (let i = 0; i < M; i++) {
    const k = ks[i] ?? 0;
    const km = k - p.m;
    // Inline `√(km² + σ²)` rather than Math.hypot — hypot is overflow-safe
    // but ≈20× slower on V8 arm64. The LM keeps `km` and `σ` in O(1) ranges
    // via reparametrisation, so overflow is impossible. Adopter-facing
    // `svi.ts:w()` keeps Math.hypot for arbitrary-k evaluation safety.
    const wHat =
      p.a + p.b * (p.rho * km + Math.sqrt(km * km + p.sigma * p.sigma));
    r[i] = (sqrtWeights[i] ?? 1) * (wHat - (ws[i] ?? 0));
  }
  const violation = levelViolation(p);
  r[M] = violation < 0 ? -levelPenalty * violation : 0;
  if (floor !== undefined) {
    const nFloor = floor.kPoints.length;
    for (let j = 0; j < nFloor; j++) {
      const k = floor.kPoints[j] as number;
      const f = floor.floorValues[j] as number;
      const km = k - p.m;
      const wHat =
        p.a + p.b * (p.rho * km + Math.sqrt(km * km + p.sigma * p.sigma));
      const v = f - wHat;
      r[M + 1 + j] = v > 0 ? floorWeight * v : 0;
    }
  }
  return r;
}

function computeJacobian(
  u: readonly number[],
  ks: readonly number[],
  sqrtWeights: readonly number[],
  M_TOTAL: number,
  N: number,
  levelPenalty: number,
  floor: CalendarFloorConstraints | undefined,
  floorWeight: number,
): Float64Array {
  const p = unconstrainedRaw(u);
  const J = new Float64Array(M_TOTAL * N);
  const M = ks.length;
  for (let i = 0; i < M; i++) {
    const sw = sqrtWeights[i] ?? 1;
    const rp = reparamPartials(ks[i] ?? 0, p);
    J[i * N + 0] = sw * rp.da;
    J[i * N + 1] = sw * rp.dbTilde;
    J[i * N + 2] = sw * rp.dRhoTilde;
    J[i * N + 3] = sw * rp.dm;
    J[i * N + 4] = sw * rp.dSigmaTilde;
  }
  const violation = levelViolation(p);
  if (violation < 0) {
    // Penalty row r = −L·violation; ∂r/∂u = −L · ∂violation/∂u with
    // chain rule for reparametrised variables.
    const oneMinusRhoSq = (1 - p.rho) * (1 + p.rho);
    const safe = oneMinusRhoSq < 0 ? 0 : oneMinusRhoSq;
    const sqrtOmr = Math.sqrt(safe);
    const dV_da = 1;
    const dV_db = p.sigma * sqrtOmr;
    const dV_drho = sqrtOmr > 1e-15 ? (-p.b * p.sigma * p.rho) / sqrtOmr : 0;
    const dV_dm = 0;
    const dV_dsigma = p.b * sqrtOmr;
    const dB = 1 - Math.exp(-p.b);
    const dRho = (1 - p.rho) * (1 + p.rho);
    const dSigma = 1 - Math.exp(-p.sigma);
    J[M * N + 0] = -levelPenalty * dV_da;
    J[M * N + 1] = -levelPenalty * dV_db * dB;
    J[M * N + 2] = -levelPenalty * dV_drho * dRho;
    J[M * N + 3] = -levelPenalty * dV_dm;
    J[M * N + 4] = -levelPenalty * dV_dsigma * dSigma;
  } else {
    for (let j = 0; j < N; j++) J[M * N + j] = 0;
  }
  if (floor !== undefined) {
    const nFloor = floor.kPoints.length;
    for (let j = 0; j < nFloor; j++) {
      const k = floor.kPoints[j] as number;
      const f = floor.floorValues[j] as number;
      const km = k - p.m;
      const wHat =
        p.a + p.b * (p.rho * km + Math.sqrt(km * km + p.sigma * p.sigma));
      const rowOffset = (M + 1 + j) * N;
      if (f - wHat > 0) {
        // Floor residual r = L·(floor − w_hat); ∂r/∂u = −L · ∂w_hat/∂u with
        // chain rule for reparametrised variables. Reuse `reparamPartials`
        // which already encodes the chain rule.
        const rp = reparamPartials(k, p);
        J[rowOffset + 0] = -floorWeight * rp.da;
        J[rowOffset + 1] = -floorWeight * rp.dbTilde;
        J[rowOffset + 2] = -floorWeight * rp.dRhoTilde;
        J[rowOffset + 3] = -floorWeight * rp.dm;
        J[rowOffset + 4] = -floorWeight * rp.dSigmaTilde;
      } else {
        for (let c = 0; c < N; c++) J[rowOffset + c] = 0;
      }
    }
  }
  return J;
}
