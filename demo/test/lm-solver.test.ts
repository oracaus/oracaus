import { describe, expect, it } from "vitest";

import { levenbergMarquardt } from "../src/svi/lm-solver.js";

// =====================================================================
// Linear LS — exact recovery (LM should converge in essentially one step)
// =====================================================================

describe("Levenberg-Marquardt — linear least-squares", () => {
  it("recovers a · x + b from clean linear data to default tolerance", () => {
    // True a = 2.5, b = -1.3; ten data points.
    // For LS-linear problems the LM stops at the gradient tolerance
    // (default 1e-8 · (1 + ||p||)); the relative parameter error tracks
    // that bound — ≈10⁻¹¹, well below 1e-9 here.
    const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const ys = xs.map((x) => 2.5 * x - 1.3);
    const M = xs.length;
    const result = levenbergMarquardt(
      [0, 0],
      (p) => {
        const r = new Float64Array(M);
        for (let i = 0; i < M; i++)
          r[i] = (p[0] ?? 0) * (xs[i] ?? 0) + (p[1] ?? 0) - (ys[i] ?? 0);
        return r;
      },
      (_p) => {
        const J = new Float64Array(M * 2);
        for (let i = 0; i < M; i++) {
          J[i * 2] = xs[i] ?? 0;
          J[i * 2 + 1] = 1;
        }
        return J;
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params[0]).toBeCloseTo(2.5, 9);
      expect(result.params[1]).toBeCloseTo(-1.3, 9);
      expect(result.residualNorm).toBeLessThan(1e-8);
    }
  });

  it("converges to machine precision under tightened tolerances", () => {
    // Tighten gradient tolerance to demonstrate the LM can drive the
    // residual to numerical zero on linear data.
    const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const ys = xs.map((x) => 2.5 * x - 1.3);
    const M = xs.length;
    const result = levenbergMarquardt(
      [0, 0],
      (p) => {
        const r = new Float64Array(M);
        for (let i = 0; i < M; i++)
          r[i] = (p[0] ?? 0) * (xs[i] ?? 0) + (p[1] ?? 0) - (ys[i] ?? 0);
        return r;
      },
      (_p) => {
        const J = new Float64Array(M * 2);
        for (let i = 0; i < M; i++) {
          J[i * 2] = xs[i] ?? 0;
          J[i * 2 + 1] = 1;
        }
        return J;
      },
      { gradientTolerance: 1e-15, stepTolerance: 1e-15 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params[0]).toBeCloseTo(2.5, 12);
      expect(result.params[1]).toBeCloseTo(-1.3, 12);
      expect(result.residualNorm).toBeLessThan(1e-10);
    }
  });
});

// =====================================================================
// Rosenbrock — classic non-convex valley, two-residual NLS form
// =====================================================================

describe("Levenberg-Marquardt — Rosenbrock", () => {
  it("finds the (1, 1) minimum from cold start (-1.2, 1)", () => {
    // f(x, y) = (1 − x)² + 100·(y − x²)² as ||r||² with
    //   r₁ = 1 − x         ∂r₁/∂x = -1     ∂r₁/∂y = 0
    //   r₂ = 10·(y − x²)   ∂r₂/∂x = -20·x  ∂r₂/∂y = 10
    const result = levenbergMarquardt(
      [-1.2, 1.0],
      (p) => {
        const x = p[0] ?? 0;
        const y = p[1] ?? 0;
        return new Float64Array([1 - x, 10 * (y - x * x)]);
      },
      (p) => {
        const x = p[0] ?? 0;
        return new Float64Array([-1, 0, -20 * x, 10]);
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params[0]).toBeCloseTo(1.0, 6);
      expect(result.params[1]).toBeCloseTo(1.0, 6);
      expect(result.residualNorm).toBeLessThan(1e-6);
    }
  });
});

// =====================================================================
// NIST StRD — Misra1a (combustion data, 14 obs, 2 params)
//   y = b1 · (1 − exp(−b2 · x))
//   Certified: b1 = 238.94212918, b2 = 5.5015643181e-04
// =====================================================================

const MISRA1A = {
  // y, x columns from NIST misra1a.dat
  ys: [
    10.07, 14.73, 17.94, 23.93, 29.61, 35.18, 40.02, 44.82, 50.76, 55.05, 61.01,
    66.4, 75.47, 81.78,
  ],
  xs: [
    77.6, 114.9, 141.1, 190.8, 239.9, 289.0, 332.8, 378.4, 434.8, 477.3, 536.8,
    593.1, 689.1, 760.0,
  ],
  certified: [238.94212918, 5.5015643181e-4] as const,
  startEasy: [250, 0.0005] as const,
  startHard: [500, 0.0001] as const,
};

describe("Levenberg-Marquardt — NIST Misra1a", () => {
  const { ys, xs, certified } = MISRA1A;
  const M = ys.length;

  const residual = (p: readonly number[]) => {
    const b1 = p[0] ?? 0;
    const b2 = p[1] ?? 0;
    const r = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      r[i] = b1 * (1 - Math.exp(-b2 * (xs[i] ?? 0))) - (ys[i] ?? 0);
    }
    return r;
  };

  const jacobian = (p: readonly number[]) => {
    const b1 = p[0] ?? 0;
    const b2 = p[1] ?? 0;
    const J = new Float64Array(M * 2);
    for (let i = 0; i < M; i++) {
      const xi = xs[i] ?? 0;
      const exi = Math.exp(-b2 * xi);
      J[i * 2] = 1 - exi; // ∂r/∂b1
      J[i * 2 + 1] = b1 * xi * exi; // ∂r/∂b2
    }
    return J;
  };

  it("recovers certified params from the easy start within 6 sig figs", () => {
    const result = levenbergMarquardt(
      MISRA1A.startEasy.slice(),
      residual,
      jacobian,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params[0]).toBeCloseTo(certified[0], 4);
      expect(result.params[1]).toBeCloseTo(certified[1], 9);
    }
  });

  it("recovers certified params from the hard start", () => {
    const result = levenbergMarquardt(
      MISRA1A.startHard.slice(),
      residual,
      jacobian,
      { maxIterations: 200 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params[0]).toBeCloseTo(certified[0], 3);
      expect(result.params[1]).toBeCloseTo(certified[1], 8);
    }
  });
});

// =====================================================================
// Lanczos1-style 6-parameter exponential-sum NLS
//   y = b1·exp(−b2·x) + b3·exp(−b4·x) + b5·exp(−b6·x)
//   Parameter set from NIST Lanczos1 certified: (0.0951, 1, 0.8607, 3,
//   1.5576, 5). The y data is generated here at Float64 precision rather
//   than transcribed from NIST's 4-sig-fig file: rounding in NIST's data
//   shifts the global minimum off-certified by ≈0.5 % (basic LM converges
//   to a different — better-fitting — minimum on the rounded data, since
//   the certified params are the true generators but not the LS optimum
//   of the rounded data). With Float64 data, the certified params ARE the
//   minimum and recovery is exact.
//
//   The test exercises the LM machinery on a 6-parameter exponential-sum
//   residual surface — the property the LM-solver gate is checking. The
//   permutation-symmetric basin is narrow, so the start is ≈1 % off
//   certified; the SVI form (Block 5) has a much wider basin and Block
//   4's Zeliade initial guess delivers a ≤5 %-accurate start.
// =====================================================================

function lanczosCertifiedY(xs: readonly number[]): readonly number[] {
  const c = [9.51e-2, 1.0, 8.607e-1, 3.0, 1.5576, 5.0] as const;
  return xs.map(
    (x) =>
      c[0] * Math.exp(-c[1] * x) +
      c[2] * Math.exp(-c[3] * x) +
      c[4] * Math.exp(-c[5] * x),
  );
}

const LANCZOS = {
  xs: Array.from({ length: 24 }, (_, i) => i * 0.05),
  get ys() {
    return lanczosCertifiedY(this.xs);
  },
  certified: [9.51e-2, 1.0, 8.607e-1, 3.0, 1.5576, 5.0] as const,
  startNear: [0.0951, 1.005, 0.86, 3.005, 1.555, 5.01] as const,
};

describe("Levenberg-Marquardt — Lanczos1-style exponential-sum", () => {
  const { xs, certified, startNear } = LANCZOS;
  const ys = LANCZOS.ys;
  const M = ys.length;

  const residual = (p: readonly number[]) => {
    const r = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      const xi = xs[i] ?? 0;
      const f =
        (p[0] ?? 0) * Math.exp(-(p[1] ?? 0) * xi) +
        (p[2] ?? 0) * Math.exp(-(p[3] ?? 0) * xi) +
        (p[4] ?? 0) * Math.exp(-(p[5] ?? 0) * xi);
      r[i] = f - (ys[i] ?? 0);
    }
    return r;
  };

  const jacobian = (p: readonly number[]) => {
    const J = new Float64Array(M * 6);
    for (let i = 0; i < M; i++) {
      const xi = xs[i] ?? 0;
      const e1 = Math.exp(-(p[1] ?? 0) * xi);
      const e2 = Math.exp(-(p[3] ?? 0) * xi);
      const e3 = Math.exp(-(p[5] ?? 0) * xi);
      J[i * 6 + 0] = e1;
      J[i * 6 + 1] = -(p[0] ?? 0) * xi * e1;
      J[i * 6 + 2] = e2;
      J[i * 6 + 3] = -(p[2] ?? 0) * xi * e2;
      J[i * 6 + 4] = e3;
      J[i * 6 + 5] = -(p[4] ?? 0) * xi * e3;
    }
    return J;
  };

  it("recovers certified params from a near start to machine precision", () => {
    const result = levenbergMarquardt(startNear.slice(), residual, jacobian, {
      maxIterations: 500,
      gradientTolerance: 1e-14,
      stepTolerance: 1e-14,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (let i = 0; i < 6; i++) {
        const got = result.params[i] ?? Number.NaN;
        const want = certified[i] ?? Number.NaN;
        expect(Math.abs(got - want) / Math.abs(want)).toBeLessThan(1e-6);
      }
      expect(result.residualNorm).toBeLessThan(1e-8);
    }
  });
});

// =====================================================================
// NIST StRD — MGH09 (Kowalik-Osborne, 11 obs, 4 params, rational)
//   y = b1·(x² + b2·x) / (x² + b3·x + b4)
//   Certified: (0.19281, 0.19128, 0.12306, 0.13606)
// =====================================================================

const MGH09 = {
  ys: [
    0.1957, 0.1947, 0.1735, 0.16, 0.0844, 0.0627, 0.0456, 0.0342, 0.0323,
    0.0235, 0.0246,
  ],
  xs: [4.0, 2.0, 1.0, 0.5, 0.25, 0.167, 0.125, 0.1, 0.0833, 0.0714, 0.0625],
  certified: [
    1.9280693458e-1, 1.9128232873e-1, 1.2305650693e-1, 1.3606233068e-1,
  ] as const,
  startCloser: [0.25, 0.39, 0.415, 0.39] as const,
};

describe("Levenberg-Marquardt — NIST MGH09", () => {
  const { ys, xs, certified, startCloser } = MGH09;
  const M = ys.length;

  const residual = (p: readonly number[]) => {
    const r = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      const x = xs[i] ?? 0;
      const num = (p[0] ?? 0) * (x * x + (p[1] ?? 0) * x);
      const den = x * x + (p[2] ?? 0) * x + (p[3] ?? 0);
      r[i] = num / den - (ys[i] ?? 0);
    }
    return r;
  };

  const jacobian = (p: readonly number[]) => {
    const J = new Float64Array(M * 4);
    for (let i = 0; i < M; i++) {
      const x = xs[i] ?? 0;
      const numCore = x * x + (p[1] ?? 0) * x;
      const den = x * x + (p[2] ?? 0) * x + (p[3] ?? 0);
      const den2 = den * den;
      const num = (p[0] ?? 0) * numCore;
      // ∂/∂b1 = numCore / den
      J[i * 4 + 0] = numCore / den;
      // ∂/∂b2 = b1·x / den
      J[i * 4 + 1] = ((p[0] ?? 0) * x) / den;
      // ∂/∂b3 = -num · x / den²
      J[i * 4 + 2] = (-num * x) / den2;
      // ∂/∂b4 = -num / den²
      J[i * 4 + 3] = -num / den2;
    }
    return J;
  };

  it("recovers certified params from the closer start within 3 sig figs", () => {
    // MGH09 is "higher" difficulty in NIST's classification — parameters
    // are highly correlated and the residual surface is strongly
    // anisotropic. 3 digits from start 2 is the standard achievable.
    const result = levenbergMarquardt(startCloser.slice(), residual, jacobian, {
      maxIterations: 500,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (let i = 0; i < 4; i++) {
        const got = result.params[i] ?? Number.NaN;
        const want = certified[i] ?? Number.NaN;
        expect(Math.abs(got - want) / Math.abs(want)).toBeLessThan(1e-3);
      }
    }
  });
});

// =====================================================================
// Failure-mode tests
// =====================================================================

describe("Levenberg-Marquardt — failure modes", () => {
  it("returns max-iterations when starved of iterations", () => {
    // Misra1a from hard start with cap = 5 — won't converge
    const result = levenbergMarquardt(
      MISRA1A.startHard.slice(),
      (p) => {
        const r = new Float64Array(MISRA1A.ys.length);
        for (let i = 0; i < MISRA1A.ys.length; i++) {
          r[i] =
            (p[0] ?? 0) * (1 - Math.exp(-(p[1] ?? 0) * (MISRA1A.xs[i] ?? 0))) -
            (MISRA1A.ys[i] ?? 0);
        }
        return r;
      },
      (p) => {
        const J = new Float64Array(MISRA1A.ys.length * 2);
        for (let i = 0; i < MISRA1A.ys.length; i++) {
          const xi = MISRA1A.xs[i] ?? 0;
          const exi = Math.exp(-(p[1] ?? 0) * xi);
          J[i * 2] = 1 - exi;
          J[i * 2 + 1] = (p[0] ?? 0) * xi * exi;
        }
        return J;
      },
      { maxIterations: 5 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("max-iterations");
      expect(result.iterations).toBe(5);
    }
  });

  it("returns non-finite-residual when residual returns NaN at the start", () => {
    const result = levenbergMarquardt(
      [1, 1],
      () => new Float64Array([Number.NaN, 0]),
      () => new Float64Array([1, 0, 0, 1]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("non-finite-residual");
  });

  it("returns non-finite-jacobian when Jacobian returns NaN at the start", () => {
    const result = levenbergMarquardt(
      [1, 1],
      () => new Float64Array([0.1, 0.1]),
      () => new Float64Array([1, Number.NaN, 0, 1]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("non-finite-jacobian");
  });
});
