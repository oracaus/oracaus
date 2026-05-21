import { describe, expect, it } from "vitest";

import { fitSviSlice } from "../src/svi/fitter.js";
import type { Quote } from "../src/svi/svi.js";

const baseQuote = (k: number, iv: number): Quote => ({
  logMoneyness: k,
  impliedVol: iv,
});

describe("SVI fitter — edge case taxonomy", () => {
  it("NaN logMoneyness → invalid-input (not an exception, not NaN result)", () => {
    const r = fitSviSlice({
      quotes: [
        baseQuote(Number.NaN, 0.2),
        baseQuote(0.1, 0.21),
        baseQuote(0.2, 0.22),
      ],
      timeToExpiry: 0.5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid-input");
      expect(r.details.field).toBe("logMoneyness");
    }
  });

  it("Infinity IV → invalid-input", () => {
    const r = fitSviSlice({
      quotes: [
        baseQuote(0, 0.2),
        baseQuote(0.1, Number.POSITIVE_INFINITY),
        baseQuote(0.2, 0.22),
      ],
      timeToExpiry: 0.5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid-input");
      expect(r.details.field).toBe("impliedVol");
    }
  });

  it("Single quote → underdetermined", () => {
    const r = fitSviSlice({
      quotes: [baseQuote(0, 0.2)],
      timeToExpiry: 0.5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("underdetermined");
  });

  it("All quotes at the same k (rank-deficient design) → underdetermined", () => {
    // Design columns (1, k − m, √((k−m)² + σ²)) collapse to rank ≤ 2 when
    // all k are equal. The 5-parameter SVI fit is structurally
    // under-determined — fail fast rather than ridge-regulariser our way
    // to an arbitrary answer.
    const r = fitSviSlice({
      quotes: [
        baseQuote(0, 0.2),
        baseQuote(0, 0.21),
        baseQuote(0, 0.22),
        baseQuote(0, 0.23),
      ],
      timeToExpiry: 0.5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("underdetermined");
      expect(r.details.uniqueLogMoneynessCount).toBe(1);
      expect(r.details.minRequired).toBe(3);
    }
  });

  it("Two distinct k (still rank-deficient for 3-col inner LS) → underdetermined", () => {
    const r = fitSviSlice({
      quotes: [baseQuote(0, 0.2), baseQuote(0.1, 0.21), baseQuote(0, 0.22)],
      timeToExpiry: 0.5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("underdetermined");
      expect(r.details.uniqueLogMoneynessCount).toBe(2);
    }
  });

  it("Negative weight → invalid-input", () => {
    const r = fitSviSlice({
      quotes: [
        { logMoneyness: 0, impliedVol: 0.2, weight: -1 },
        baseQuote(0.1, 0.21),
        baseQuote(0.2, 0.22),
      ],
      timeToExpiry: 0.5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid-input");
      expect(r.details.field).toBe("weight");
    }
  });

  it("Negative IV → invalid-input", () => {
    const r = fitSviSlice({
      quotes: [baseQuote(0, 0.2), baseQuote(0.1, -0.05), baseQuote(0.2, 0.22)],
      timeToExpiry: 0.5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid-input");
      expect(r.details.field).toBe("impliedVol");
    }
  });

  it("Subnormal IV mixed with clustered valid quotes → no-convergence (initial-guess infeasible)", () => {
    // Subnormal: IV = 5e-324 (smallest positive Float64). impliedVol > 0
    // passes input validation; ivToVariance produces 0 (underflow). On a
    // clustered 3-quote slice no Zeliade grid point produces b ≥ MIN_B,
    // so the fitter returns a clean `no-convergence` diagnostic at the
    // initial-guess stage rather than a silent constant-w fit. Contract:
    // no crash, no NaN-result, no exception — just an explicit failure
    // reason. Adopters can scrub data and retry.
    const r = fitSviSlice({
      quotes: [baseQuote(0, 5e-324), baseQuote(0.1, 0.2), baseQuote(0.2, 0.21)],
      timeToExpiry: 0.5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no-convergence");
      expect(r.details.stage).toBe("initial-guess");
    }
  });

  it("LM iteration cap exhaustion → no-convergence with iteration count = cap", () => {
    // Pinning the iteration cap at 1 alone is not sufficient: Zeliade
    // init + one Gauss-Newton step often lands inside default gradient
    // tolerance for clean synthetic data. Tightening gradTol/stepTol to
    // machine epsilon makes the cap genuinely binding — one iteration
    // cannot reach 1e-15 in either norm.
    const r = fitSviSlice(
      {
        quotes: Array.from({ length: 11 }, (_, i) => ({
          logMoneyness: -0.5 + i * 0.1,
          impliedVol: 0.2 + 0.05 * Math.abs(-0.5 + i * 0.1),
        })),
        timeToExpiry: 0.5,
      },
      {
        lm: {
          maxIterations: 1,
          gradientTolerance: 1e-15,
          stepTolerance: 1e-15,
        },
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no-convergence");
      expect(r.details.stage).toBe("lm");
      expect(r.details.iterations).toBe(1);
      expect(typeof r.details.lastResidualNorm).toBe("number");
    }
  });

  it("NaN weight → invalid-input", () => {
    const r = fitSviSlice({
      quotes: [
        { logMoneyness: 0, impliedVol: 0.2, weight: Number.NaN },
        baseQuote(0.1, 0.21),
        baseQuote(0.2, 0.22),
      ],
      timeToExpiry: 0.5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid-input");
      expect(r.details.field).toBe("weight");
    }
  });
});

describe("SVI fitter — diagnostic surface on success", () => {
  it("exposes initial-guess grid and LM-convergence reason on a successful fit", () => {
    const r = fitSviSlice({
      quotes: Array.from({ length: 15 }, (_, i) => ({
        logMoneyness: -0.5 + i * 0.07,
        impliedVol: 0.2 + 0.03 * Math.abs(-0.5 + i * 0.07),
      })),
      timeToExpiry: 0.75,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(["gradient-tolerance", "step-tolerance"]).toContain(
        r.diagnostics.reason,
      );
      expect(r.diagnostics.damping).toBeGreaterThanOrEqual(0);
      expect(r.diagnostics.initialGuessResidualNorm).toBeGreaterThanOrEqual(0);
    }
  });
});
