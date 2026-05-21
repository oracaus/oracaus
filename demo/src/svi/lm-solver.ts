// Generic Levenberg-Marquardt solver for nonlinear least-squares. SVI-free
// — the SVI fitter composes residual + Jacobian callbacks and
// hands them to this routine.
//
// References:
//   - Madsen, Nielsen & Tingleff, "Methods for Non-Linear Least Squares
//     Problems" (2nd ed., IMM, DTU 2004), Section 3 (LM).
//   - Marquardt, "An algorithm for least-squares estimation of nonlinear
//     parameters" (J. SIAM 11.2, 1963), for the 2× / 10× damping update.
//
// Form solved at each iteration (Marquardt's scale-invariant damping):
//
//     (Jᵀ J + λ · diag(Jᵀ J)) δ = − Jᵀ r,     p ← p + δ
//
// where r ∈ Rᴹ is the residual vector and J ∈ Rᴹˣᴺ its Jacobian. The
// damping multiplier λ is dimensionless and adapts: on accepted step,
// λ ← λ / 2; on rejected step, λ ← λ × 10. Initial λ = `initialDamping`
// (dimensionless, default 1e-3). Marquardt's diagonal form is essential
// when parameter scales differ by orders of magnitude (e.g. NIST Misra1a
// has |Jᵀ J| diagonal entries spanning ≈ 10¹¹) — the equivalent λ·I
// formulation over-suppresses the small-scale direction.
//
// For a Jacobian column with zero diagonal (rank-deficient direction),
// the diagonal is floored at `1e-12 · max(diag(Jᵀ J))` before scaling, so
// the damped matrix stays non-singular even on rank-deficient inputs
// (which the LM then either escapes or surfaces as a non-convergence).
//
// Linear solve via Cholesky on (Jᵀ J + λ I), which is symmetric positive
// definite for any λ > 0. A failed factorisation (a singular pivot from
// rank-deficient J) is treated as a rejected step — λ increases and the
// iteration retries.
//
// Soft-penalty support is implicit: the user simply appends penalty
// residuals to `residual(p)` and the corresponding Jacobian rows to
// `jacobian(p)`. The LM has no special handling — it minimises
// ||r||² regardless of which rows are data and which are penalties.
//
// Three convergence criteria are checked each iteration; the result
// records which one fired:
//   - gradient: ||Jᵀ r||∞ < gradientTolerance · (1 + ||p||₂)
//   - step:     ||δ||₂   < stepTolerance     · (1 + ||p||₂)
//   - max iterations reached → no-convergence

export type ResidualFn = (params: readonly number[]) => Float64Array;

/**
 * Returns the Jacobian as a row-major M×N Float64Array; row index runs
 * over residuals, column index over parameters. (The caller decides how
 * to lay out the dense matrix — this is the simplest contiguous form.)
 */
export type JacobianFn = (params: readonly number[]) => Float64Array;

export type LmOptions = {
  /** Initial damping as fraction of max(diag(Jᵀ J)). Default 1e-3. */
  readonly initialDamping?: number;
  /** Iteration cap. Default 100. */
  readonly maxIterations?: number;
  /** Gradient infinity-norm tolerance. Default 1e-8. */
  readonly gradientTolerance?: number;
  /** Step Euclidean-norm tolerance. Default 1e-8. */
  readonly stepTolerance?: number;
  /** Damping multipliers `[increaseOnReject, decreaseOnAccept]`. Default `[10, 0.5]`. */
  readonly dampingFactors?: readonly [number, number];
};

export type LmConvergenceReason = "gradient-tolerance" | "step-tolerance";

export type LmFailureReason =
  | "max-iterations"
  | "non-finite-residual"
  | "non-finite-jacobian"
  | "linear-solve-failed";

export type LmResult =
  | {
      readonly ok: true;
      readonly params: readonly number[];
      readonly iterations: number;
      readonly residualNorm: number;
      readonly reason: LmConvergenceReason;
      readonly damping: number;
    }
  | {
      readonly ok: false;
      readonly reason: LmFailureReason;
      readonly params: readonly number[];
      readonly iterations: number;
      readonly residualNorm: number;
    };

const DEFAULT_INITIAL_DAMPING = 1e-3;
const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_GRAD_TOL = 1e-8;
const DEFAULT_STEP_TOL = 1e-8;
const DEFAULT_INCREASE = 10;
const DEFAULT_DECREASE = 0.5;
// Hard cap on damping growth; a runaway λ indicates a degenerate problem.
const MAX_DAMPING = 1e30;

export function levenbergMarquardt(
  initial: readonly number[],
  residual: ResidualFn,
  jacobian: JacobianFn,
  options: LmOptions = {},
): LmResult {
  const N = initial.length;
  const initialDamping = options.initialDamping ?? DEFAULT_INITIAL_DAMPING;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const gradTol = options.gradientTolerance ?? DEFAULT_GRAD_TOL;
  const stepTol = options.stepTolerance ?? DEFAULT_STEP_TOL;
  const increase = options.dampingFactors?.[0] ?? DEFAULT_INCREASE;
  const decrease = options.dampingFactors?.[1] ?? DEFAULT_DECREASE;

  const params = initial.slice();

  let r = residual(params);
  if (!isFiniteFloat64(r)) {
    return failure("non-finite-residual", params, 0, Number.NaN);
  }
  let costSq = sumSquares(r);

  let J = jacobian(params);
  const M = r.length;
  if (J.length !== M * N) {
    throw new Error(
      `jacobian length ${J.length} does not match expected M*N = ${M}*${N}`,
    );
  }
  if (!isFiniteFloat64(J)) {
    return failure("non-finite-jacobian", params, 0, Math.sqrt(costSq));
  }

  let lambda = initialDamping;

  for (let iter = 0; iter < maxIterations; iter++) {
    const JtJ = computeJtJ(J, M, N);
    const Jtr = computeJtr(J, r, M, N);
    // J only changes on accepted steps; max-diag is constant across the
    // inner reject-retry loop. Hoisted out of the inner while.
    const maxDiag = maxDiagJtJ(J, M, N);
    const floorDiag = maxDiag * 1e-12;

    const gradInf = infNorm(Jtr);
    const paramNorm = euclideanNorm(params);
    if (gradInf < gradTol * (1 + paramNorm)) {
      return {
        ok: true,
        params: params.slice(),
        iterations: iter,
        residualNorm: Math.sqrt(costSq),
        reason: "gradient-tolerance",
        damping: lambda,
      };
    }

    let stepAccepted = false;

    // Inner loop: try damping; on reject, increase λ and retry without
    // counting an outer iteration. Bounded by MAX_DAMPING — runaway is
    // surfaced as linear-solve-failed.
    while (!stepAccepted) {
      if (lambda > MAX_DAMPING) {
        return failure("linear-solve-failed", params, iter, Math.sqrt(costSq));
      }
      const damped = JtJ.slice();
      for (let i = 0; i < N; i++) {
        const d = damped[i * N + i] ?? 0;
        const dEff = d > floorDiag ? d : floorDiag;
        damped[i * N + i] = d + lambda * dEff;
      }
      const negJtr = new Float64Array(N);
      for (let i = 0; i < N; i++) negJtr[i] = -(Jtr[i] ?? 0);

      const delta = solveSpd(damped, negJtr, N);
      if (!delta) {
        lambda *= increase;
        continue;
      }

      const trial = new Array<number>(N);
      for (let i = 0; i < N; i++) trial[i] = (params[i] ?? 0) + (delta[i] ?? 0);
      const trialR = residual(trial);
      if (!isFiniteFloat64(trialR)) {
        lambda *= increase;
        continue;
      }
      const trialCost = sumSquares(trialR);
      if (trialCost < costSq) {
        for (let i = 0; i < N; i++) params[i] = trial[i] ?? 0;
        r = trialR;
        costSq = trialCost;
        const newJ = jacobian(params);
        if (newJ.length !== M * N) {
          throw new Error(
            `jacobian length ${newJ.length} does not match expected M*N = ${M}*${N}`,
          );
        }
        if (!isFiniteFloat64(newJ)) {
          return failure(
            "non-finite-jacobian",
            params,
            iter + 1,
            Math.sqrt(costSq),
          );
        }
        J = newJ;
        lambda *= decrease;
        stepAccepted = true;

        // Step-tolerance check ONLY on accepted steps. Checking pre-accept
        // (inside the reject-retry loop) is unsound: a strongly-damped λ
        // produces small δ that pass the tolerance but represent a stuck
        // state at a non-optimum, not convergence. MNT 2004 §3.2 — step
        // criterion applies to the just-accepted step against the new p.
        const stepNormAccepted = euclideanNorm(delta);
        const newParamNorm = euclideanNorm(params);
        if (stepNormAccepted < stepTol * (1 + newParamNorm)) {
          return {
            ok: true,
            params: params.slice(),
            iterations: iter + 1,
            residualNorm: Math.sqrt(costSq),
            reason: "step-tolerance",
            damping: lambda,
          };
        }
      } else {
        lambda *= increase;
      }
    }
  }

  return failure("max-iterations", params, maxIterations, Math.sqrt(costSq));
}

// ----- internal helpers -----

function failure(
  reason: LmFailureReason,
  params: readonly number[],
  iterations: number,
  residualNorm: number,
): LmResult {
  return {
    ok: false,
    reason,
    params: params.slice(),
    iterations,
    residualNorm,
  };
}

function isFiniteFloat64(a: Float64Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) return false;
  }
  return true;
}

function sumSquares(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i] ?? 0;
    s += v * v;
  }
  return s;
}

function euclideanNorm(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i] ?? 0;
    s += v * v;
  }
  return Math.sqrt(s);
}

function infNorm(a: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i] ?? 0);
    if (v > m) m = v;
  }
  return m;
}

function maxDiagJtJ(J: Float64Array, M: number, N: number): number {
  let m = 0;
  for (let j = 0; j < N; j++) {
    let s = 0;
    for (let i = 0; i < M; i++) {
      const v = J[i * N + j] ?? 0;
      s += v * v;
    }
    if (s > m) m = s;
  }
  return m;
}

function computeJtJ(J: Float64Array, M: number, N: number): Float64Array {
  const out = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      let s = 0;
      for (let k = 0; k < M; k++) {
        s += (J[k * N + i] ?? 0) * (J[k * N + j] ?? 0);
      }
      out[i * N + j] = s;
      if (i !== j) out[j * N + i] = s;
    }
  }
  return out;
}

function computeJtr(
  J: Float64Array,
  r: Float64Array,
  M: number,
  N: number,
): Float64Array {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = 0; k < M; k++) {
      s += (J[k * N + i] ?? 0) * (r[k] ?? 0);
    }
    out[i] = s;
  }
  return out;
}

/**
 * Solves A x = b where A is N×N symmetric positive definite via Cholesky
 * factorisation. Returns null on a non-positive pivot (rank-deficient or
 * indefinite A).
 */
function solveSpd(
  A: Float64Array,
  b: Float64Array,
  N: number,
): Float64Array | null {
  const L = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * N + j] ?? 0;
      for (let k = 0; k < j; k++) {
        sum -= (L[i * N + k] ?? 0) * (L[j * N + k] ?? 0);
      }
      if (i === j) {
        if (!(sum > 0) || !Number.isFinite(sum)) return null;
        L[i * N + j] = Math.sqrt(sum);
      } else {
        const pivot = L[j * N + j] ?? 0;
        if (pivot === 0) return null;
        L[i * N + j] = sum / pivot;
      }
    }
  }
  // Forward and back substitution: L[i,i] is strictly positive by the
  // pivot check above. The non-null assertions document this invariant —
  // a `?? 1` fallback would silently corrupt the answer if the invariant
  // ever broke (rather than failing fast).
  const y = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let sum = b[i] ?? 0;
    for (let k = 0; k < i; k++) {
      sum -= (L[i * N + k] ?? 0) * (y[k] ?? 0);
    }
    const diag = L[i * N + i];
    if (diag === undefined) throw new Error(`solveSpd: L[${i},${i}] missing`);
    y[i] = sum / diag;
  }
  const x = new Float64Array(N);
  for (let i = N - 1; i >= 0; i--) {
    let sum = y[i] ?? 0;
    for (let k = i + 1; k < N; k++) {
      sum -= (L[k * N + i] ?? 0) * (x[k] ?? 0);
    }
    const diag = L[i * N + i];
    if (diag === undefined) throw new Error(`solveSpd: L[${i},${i}] missing`);
    x[i] = sum / diag;
  }
  return x;
}
