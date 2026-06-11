// `computeTruthMisses` — the ground-truth fit error surfaced in the option-
// chain hero card. Unlike `computeMisses` (fit vs observed quotes, the
// coherence tear), this measures the fit against the TRUE surface at its own
// snapshot, so it isolates fitter quality from staleness. These lock the
// "fit vs truth only" semantics that make it read ~equal across both panels.

import { describe, expect, it } from "vitest";
import type { SviParams } from "../src/svi/params.js";
import { validateParams } from "../src/svi/params.js";
import type { Slice } from "../src/svi/svi.js";
import { w } from "../src/svi/svi.js";
import { computeTruthMisses, summariseMisses } from "../src/svi-mismark.js";

function mint(raw: {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}): SviParams {
  const r = validateParams(raw);
  if (!r.ok) throw new Error(`invalid test params: ${r.reason}`);
  return r.params;
}

const KS = [-0.4, -0.2, 0, 0.2, 0.4];

function sliceFor(ks: number[], iv = 0.2, T = 1): Slice {
  return {
    timeToExpiry: T,
    quotes: ks.map((k) => ({ logMoneyness: k, impliedVol: iv })),
  };
}

describe("computeTruthMisses", () => {
  // SPX-style anchor (mirrors feed.ts) and a higher-level variant.
  const truth = mint({ a: 0.04, b: 0.1, rho: -0.5, m: 0, sigma: 0.2 });
  const slice = sliceFor(KS);

  it("returns [] when any input is undefined", () => {
    expect(
      computeTruthMisses({
        slice: undefined,
        params: truth,
        trueParams: truth,
      }),
    ).toEqual([]);
    expect(
      computeTruthMisses({ slice, params: undefined, trueParams: truth }),
    ).toEqual([]);
    expect(
      computeTruthMisses({ slice, params: truth, trueParams: undefined }),
    ).toEqual([]);
  });

  it("is zero at every strike when the fit equals truth", () => {
    const rows = computeTruthMisses({
      slice,
      params: truth,
      trueParams: truth,
    });
    expect(rows).toHaveLength(KS.length);
    for (const row of rows) expect(row.miss).toBeCloseTo(0, 12);
    expect(summariseMisses(rows)?.sum).toBeCloseTo(0, 10);
  });

  it("equals fitIV − trueIV per strike, signed", () => {
    // A higher level `a` lifts total variance everywhere → fit IV > true IV
    // at every strike → strictly positive, non-trivial miss.
    const fit = mint({ a: 0.06, b: 0.1, rho: -0.5, m: 0, sigma: 0.2 });
    const rows = computeTruthMisses({ slice, params: fit, trueParams: truth });
    for (const row of rows) {
      const fitIv = Math.sqrt(w(row.k, fit) / slice.timeToExpiry);
      const trueIv = Math.sqrt(w(row.k, truth) / slice.timeToExpiry);
      expect(row.miss).toBeCloseTo(fitIv - trueIv, 12);
      expect(row.miss).toBeGreaterThan(0);
    }
    const summary = summariseMisses(rows);
    expect(summary?.sum).toBeGreaterThan(0);
  });

  it("ignores the observed quotes — it is fit vs truth, not fit vs obs", () => {
    // Same strikes + T, wildly different impliedVol: `computeTruthMisses`
    // must be invariant (it never reads `impliedVol`). This is what keeps it
    // unmoved by the staleness tear the coherence number tracks.
    const fit = mint({ a: 0.06, b: 0.1, rho: -0.5, m: 0, sigma: 0.2 });
    const a = computeTruthMisses({
      slice: sliceFor(KS, 0.2),
      params: fit,
      trueParams: truth,
    });
    const b = computeTruthMisses({
      slice: sliceFor(KS, 0.9),
      params: fit,
      trueParams: truth,
    });
    expect(a.map((r) => r.miss)).toEqual(b.map((r) => r.miss));
  });
});
