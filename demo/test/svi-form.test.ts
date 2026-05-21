import { describe, expect, it } from "vitest";
import type { SviParams } from "../src/svi/params.js";
import { levelFloor, validateParams } from "../src/svi/params.js";
import { ivToVariance, varianceToIv, w } from "../src/svi/svi.js";

const make = (
  a: number,
  b: number,
  rho: number,
  m: number,
  sigma: number,
): SviParams => {
  const r = validateParams({ a, b, rho, m, sigma });
  if (!r.ok) {
    throw new Error(
      `fixture invalid: ${r.reason} ${JSON.stringify(r.details)}`,
    );
  }
  return r.params;
};

describe("SVI w(k, params)", () => {
  it("at k = m, w = a + b·σ (the kink point)", () => {
    const p = make(0.04, 0.1, -0.3, 0.05, 0.2);
    expect(w(0.05, p)).toBeCloseTo(0.04 + 0.1 * 0.2, 12);
  });

  it("at k = 0 with m = 0, w = a + b·σ", () => {
    const p = make(0.0, 0.1, -0.5, 0.0, 0.2);
    expect(w(0, p)).toBeCloseTo(0.0 + 0.1 * 0.2, 12);
  });

  it("right-asymptotic slope approaches b·(1 + ρ) as k → ∞", () => {
    const p = make(0.04, 0.1, -0.3, 0.0, 0.2);
    const slope = (w(1000.1, p) - w(1000.0, p)) / 0.1;
    expect(slope).toBeCloseTo(0.1 * (1 + -0.3), 6);
  });

  it("left-asymptotic slope approaches b·(ρ − 1) as k → −∞", () => {
    const p = make(0.04, 0.1, -0.3, 0.0, 0.2);
    const slope = (w(-1000.0 + 0.1, p) - w(-1000.0, p)) / 0.1;
    expect(slope).toBeCloseTo(0.1 * (-0.3 - 1), 6);
  });

  it("ρ = 0 produces a w that is symmetric around k = m", () => {
    const p = make(0.04, 0.1, 0.0, 0.07, 0.2);
    for (const dk of [0.01, 0.1, 0.3, 1.0, 5.0]) {
      expect(w(0.07 + dk, p)).toBeCloseTo(w(0.07 - dk, p), 12);
    }
  });

  it("does not overflow for very large |k − m|", () => {
    const p = make(0.04, 0.1, -0.3, 0.0, 0.2);
    const v = w(1e150, p);
    expect(Number.isFinite(v)).toBe(true);
  });

  it("variance ↔ implied-vol round-trips", () => {
    const T = 0.5;
    expect(ivToVariance(0.2, T)).toBeCloseTo(0.04 * T, 12);
    expect(varianceToIv(0.04 * T, T)).toBeCloseTo(0.2, 12);
  });
});

describe("validateParams", () => {
  const valid = { a: 0.04, b: 0.1, rho: -0.3, m: 0.0, sigma: 0.2 };

  it("accepts a well-formed parameter set", () => {
    expect(validateParams(valid).ok).toBe(true);
  });

  it("rejects NaN in any parameter with reason 'non-finite'", () => {
    for (const param of ["a", "b", "rho", "m", "sigma"] as const) {
      const r = validateParams({ ...valid, [param]: NaN });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("non-finite");
        expect(r.details.param).toBe(param);
      }
    }
  });

  it("rejects ±Infinity with reason 'non-finite'", () => {
    for (const value of [Infinity, -Infinity]) {
      const r = validateParams({ ...valid, a: value });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("non-finite");
    }
  });

  it("rejects negative b with reason 'negative-b'", () => {
    const r = validateParams({ ...valid, b: -1e-9 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("negative-b");
  });

  it("accepts b = 0 (degenerate constant slice)", () => {
    expect(validateParams({ ...valid, b: 0, a: 0.01 }).ok).toBe(true);
  });

  it("rejects |ρ| > 1 with reason 'rho-out-of-range'", () => {
    for (const rho of [-1.0001, 1.0001, 2, -2]) {
      const r = validateParams({ ...valid, rho });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("rho-out-of-range");
    }
  });

  it("accepts |ρ| = 1 at the boundary (level reduces to a ≥ 0)", () => {
    expect(validateParams({ ...valid, rho: 1, a: 0 }).ok).toBe(true);
    expect(validateParams({ ...valid, rho: -1, a: 0 }).ok).toBe(true);
  });

  it("rejects σ ≤ 0 with reason 'non-positive-sigma'", () => {
    for (const sigma of [0, -1e-9]) {
      const r = validateParams({ ...valid, sigma });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("non-positive-sigma");
    }
  });

  it("rejects level violation a + b·σ·√(1 − ρ²) < 0", () => {
    // floor = -0.1·0.2·√(1 − 0.09) ≈ -0.01908
    const r = validateParams({ ...valid, a: -0.05 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("level-violation");
      expect(r.details.a).toBe(-0.05);
      expect(typeof r.details.levelFloor).toBe("number");
    }
  });

  it("accepts a = level floor exactly (boundary case)", () => {
    const floor = levelFloor(0.1, -0.3, 0.2);
    expect(validateParams({ ...valid, a: floor }).ok).toBe(true);
  });
});

describe("levelFloor numerical stability", () => {
  it("avoids catastrophic cancellation as |ρ| → 1", () => {
    // (1 − ρ)·(1 + ρ) preserves precision when ρ² rounds toward 1; the
    // expected magnitude here is √(2·(1 − ρ)) ≈ 1.4142e-5.
    const rho = 1 - 1e-10;
    const got = levelFloor(1, rho, 1);
    expect(got).toBeLessThan(0);
    expect(Math.abs(got)).toBeCloseTo(Math.sqrt(2e-10), 6);
  });

  it("is 0 at |ρ| = 1 (no level slack)", () => {
    expect(levelFloor(1, 1, 1)).toBe(-0);
    expect(levelFloor(1, -1, 1)).toBe(-0);
  });

  it("is 0 at b = 0 (degenerate)", () => {
    expect(levelFloor(0, 0, 1)).toBe(-0);
  });
});
