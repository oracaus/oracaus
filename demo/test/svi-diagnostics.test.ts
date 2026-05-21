// Verifies the per-point SVI diagnostics used by the hover overlay:
//   - `kDerivatives` (analytical first and second derivatives in k)
//   - `gatheralG` (re-exported; covered in svi-no-arb.test.ts, sanity-checked
//     here only as a smoke test for the import path).
//
// The analytical derivatives are validated against central differences on a
// reasonable sweep of `(k, params)` rather than relying on hand-derived
// values for every test — the central-difference comparison is exactly the
// trust-the-tangent verification we use for the parameter-space Jacobian
// (`svi-jacobian.test.ts`).

import { describe, expect, it } from "vitest";
import { gatheralG, kDerivatives } from "../src/svi/diagnostics.js";
import type { SviParams } from "../src/svi/params.js";
import { validateParams } from "../src/svi/params.js";
import { w } from "../src/svi/svi.js";

const make = (
  a: number,
  b: number,
  rho: number,
  m: number,
  sigma: number,
): SviParams => {
  const r = validateParams({ a, b, rho, m, sigma });
  if (!r.ok) throw new Error(`fixture invalid: ${r.reason}`);
  return r.params;
};

const FIXTURES: ReadonlyArray<readonly [string, SviParams]> = [
  ["spx-ish", make(0.04, 0.1, -0.5, 0.0, 0.2)],
  ["positive-rho", make(0.02, 0.08, 0.4, 0.1, 0.15)],
  ["near-flat", make(0.05, 0.02, 0.0, -0.1, 0.5)],
  ["off-centre", make(0.03, 0.12, -0.3, 0.25, 0.12)],
];

const K_SAMPLES = [-0.8, -0.3, -0.1, 0.0, 0.05, 0.2, 0.5, 1.0];

describe("kDerivatives — analytical k-derivatives of total variance", () => {
  it("dw/dk matches central differences across fixtures and k-samples", () => {
    const eps = 1e-6;
    for (const [, params] of FIXTURES) {
      for (const k of K_SAMPLES) {
        const { dwdk } = kDerivatives(k, params);
        const numeric = (w(k + eps, params) - w(k - eps, params)) / (2 * eps);
        // Relative tolerance loose enough to absorb finite-difference noise,
        // tight enough to catch sign or scale errors.
        expect(dwdk).toBeCloseTo(numeric, 6);
      }
    }
  });

  it("d²w/dk² matches central differences across fixtures and k-samples", () => {
    const eps = 1e-4;
    for (const [, params] of FIXTURES) {
      for (const k of K_SAMPLES) {
        const { d2wdk2 } = kDerivatives(k, params);
        const numeric =
          (w(k + eps, params) - 2 * w(k, params) + w(k - eps, params)) /
          (eps * eps);
        // Second-derivative finite differences carry more noise; allow ~4
        // decimal places of agreement.
        expect(d2wdk2).toBeCloseTo(numeric, 4);
      }
    }
  });

  it("d²w/dk² is strictly positive for all valid SVI parameters", () => {
    // Raw SVI is globally convex in k under the constraint set.
    for (const [, params] of FIXTURES) {
      for (const k of K_SAMPLES) {
        const { d2wdk2 } = kDerivatives(k, params);
        expect(d2wdk2).toBeGreaterThan(0);
      }
    }
  });

  it("dw/dk → b·(1 + ρ) as k → +∞", () => {
    const p = make(0.04, 0.1, -0.5, 0.0, 0.2);
    const { dwdk } = kDerivatives(1000, p);
    expect(dwdk).toBeCloseTo(0.1 * (1 + -0.5), 4);
  });

  it("dw/dk → b·(ρ − 1) as k → −∞", () => {
    const p = make(0.04, 0.1, -0.5, 0.0, 0.2);
    const { dwdk } = kDerivatives(-1000, p);
    expect(dwdk).toBeCloseTo(0.1 * (-0.5 - 1), 4);
  });
});

describe("gatheralG — re-export from no-arb.ts (smoke test)", () => {
  it("returns a finite number for valid parameters and finite k", () => {
    const p = make(0.04, 0.1, -0.5, 0.0, 0.2);
    expect(Number.isFinite(gatheralG(0.0, p))).toBe(true);
    expect(Number.isFinite(gatheralG(0.5, p))).toBe(true);
    expect(Number.isFinite(gatheralG(-0.5, p))).toBe(true);
  });
});
