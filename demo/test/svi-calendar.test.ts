import { describe, expect, it } from "vitest";

import { calendarCheck } from "../src/svi/no-arb.js";
import type { SviParams } from "../src/svi/params.js";
import { validateParams } from "../src/svi/params.js";

function fixture(
  a: number,
  b: number,
  rho: number,
  m: number,
  sigma: number,
): SviParams {
  const r = validateParams({ a, b, rho, m, sigma });
  if (!r.ok) throw new Error(`fixture invalid: ${r.reason}`);
  return r.params;
}

const grid = (kMin: number, kMax: number, n: number) =>
  Array.from({ length: n }, (_, i) => kMin + (i / (n - 1)) * (kMax - kMin));

describe("calendarCheck", () => {
  it("flat skew levelled by a-inflation across maturities is calendar arb-free", () => {
    // Build three slices with monotonically growing total variance via
    // increasing `a`. Same b/ρ/m/σ across slices keeps the surface shape
    // constant; only the level grows with T.
    const p1 = fixture(0.02, 0.1, -0.3, 0.0, 0.2);
    const p2 = fixture(0.04, 0.1, -0.3, 0.0, 0.2);
    const p3 = fixture(0.07, 0.1, -0.3, 0.0, 0.2);
    const slices = [
      { params: p1, timeToExpiry: 0.25 },
      { params: p2, timeToExpiry: 0.5 },
      { params: p3, timeToExpiry: 1.0 },
    ];
    const result = calendarCheck(slices, grid(-0.5, 0.5, 100));
    expect(result.arbitrageFree).toBe(true);
    expect(result.minDelta).toBeGreaterThanOrEqual(0);
    expect(result.violations).toEqual([]);
  });

  it("swapping two slices produces a calendar-arbitrage detection", () => {
    // Reverse the middle and far slice so T = 0.5 has higher level than
    // T = 1.0 — a mid-strike calendar arbitrage opens.
    const pNear = fixture(0.02, 0.1, -0.3, 0.0, 0.2);
    const pFar = fixture(0.04, 0.1, -0.3, 0.0, 0.2);
    const pMid = fixture(0.07, 0.1, -0.3, 0.0, 0.2); // mistakenly larger
    const slices = [
      { params: pNear, timeToExpiry: 0.25 },
      { params: pMid, timeToExpiry: 0.5 },
      { params: pFar, timeToExpiry: 1.0 }, // smaller-level than slice 1!
    ];
    const result = calendarCheck(slices, grid(-0.5, 0.5, 100));
    expect(result.arbitrageFree).toBe(false);
    expect(result.minDelta).toBeLessThan(0);
    expect(result.violations.length).toBeGreaterThan(0);
    // The violating slice-pair index is 1 (pMid → pFar)
    expect(result.violations[0]?.sliceIndex).toBe(1);
  });

  it("single-slice input is trivially arbitrage-free", () => {
    const p = fixture(0.04, 0.1, -0.3, 0.0, 0.2);
    const result = calendarCheck(
      [{ params: p, timeToExpiry: 0.5 }],
      grid(-0.5, 0.5, 50),
    );
    expect(result.arbitrageFree).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("throws if slices are not strictly increasing in T", () => {
    const p = fixture(0.04, 0.1, -0.3, 0.0, 0.2);
    expect(() =>
      calendarCheck(
        [
          { params: p, timeToExpiry: 0.5 },
          { params: p, timeToExpiry: 0.25 },
        ],
        grid(-0.5, 0.5, 50),
      ),
    ).toThrow(/strictly increasing/);
  });
});
