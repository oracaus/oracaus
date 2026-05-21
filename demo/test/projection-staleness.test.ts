// Regression tests for the staleness-filter on the surface projections.
//
// Symptom that motivated the fix: when the user changed `nExpiriesFitted`
// (e.g. 70 → 12), `naive.data` / `gated.data` held the **previous**
// 70-slice surface for one tick + worker drain + display throttle
// (~25–420 ms), while `displayMaturityIdx` had already snapped to the
// new 12-entry ladder. `perMaturity[newIdx]` then picked an arbitrary
// wrong slice from the old surface; the slice's IVs (often at
// out-of-domain `T`, e.g. T≈0.04 ↔ 200%+ IVs) leaked into the
// sticky-yRange envelope and pollution persisted.
//
// Fix: pass `nExpiriesFitted` as `expectedSurfaceSize`; the projection
// returns `undefined` when the surface's length disagrees. The next
// valid surface lands cleanly without ever showing or feeding the
// wrong-T slice.

import { describe, expect, it } from "vitest";
import { projectSurfaceSnapshot } from "../src/hooks/use-naive-fit.js";
import type { SviParams } from "../src/svi/params.js";
import type { Slice } from "../src/svi/svi.js";
import type { DemoSurfaceOutput, SlicedFitResult } from "../src/types.js";
import { projectMaturity } from "../src/types.js";

// ─── Test fixtures ───────────────────────────────────────────────────────────

function makeSlice(timeToExpiry: number): Slice {
  return { quotes: [], timeToExpiry };
}

function makeParams(): SviParams {
  return {
    a: 0.04,
    b: 0.1,
    rho: -0.5,
    m: 0,
    sigma: 0.2,
  } as SviParams;
}

function makeSurface(nSlices: number): DemoSurfaceOutput {
  const perMaturity: SlicedFitResult[] = [];
  for (let i = 0; i < nSlices; i += 1) {
    perMaturity.push({
      fitResult: {
        ok: true,
        params: makeParams(),
        residualNorm: 0,
        iterations: 1,
        diagnostics: {
          reason: "gradient-tolerance",
          damping: 0,
          initialGuessResidualNorm: 0,
          calibratedRange: { kMin: -1, kMax: 1 },
        },
      },
      sourceSlice: makeSlice(0.1 + i * 0.1),
      sourceTrueParams: makeParams(),
    });
  }
  return {
    perMaturity,
    surfaceArbStatus: "arb-free",
    sourceTickIndex: 0,
    computeMs: 1,
  };
}

// ─── projectMaturity ─────────────────────────────────────────────────────────

describe("projectMaturity — staleness filter", () => {
  it("returns the entry when expectedSurfaceSize matches", () => {
    const surface = makeSurface(12);
    const result = projectMaturity(surface, 5, 12);
    expect(result).toBeDefined();
    expect(result?.sourceSlice.timeToExpiry).toBeCloseTo(0.6, 6);
  });

  it("returns undefined when the surface is stale (length mismatch)", () => {
    // Stale 70-slice surface left over from before `nExpiriesFitted`
    // changed to 12. perMaturity[5] would be a T≈0.04 slice — wrong T,
    // out-of-domain IVs. Filter rejects to avoid the visible glitch and
    // the sticky-yRange envelope contamination.
    const staleSurface = makeSurface(70);
    const result = projectMaturity(staleSurface, 5, 12);
    expect(result).toBeUndefined();
  });

  it("returns the entry when expectedSurfaceSize is omitted (legacy callers)", () => {
    // The filter is opt-in. Callers that don't pass the size get the
    // previous behaviour — used to date by tests that don't care.
    const surface = makeSurface(12);
    const result = projectMaturity(surface, 5);
    expect(result).toBeDefined();
  });

  it("returns undefined for surface === undefined regardless of size", () => {
    expect(projectMaturity(undefined, 0, 12)).toBeUndefined();
    expect(projectMaturity(undefined, 0)).toBeUndefined();
  });

  it("returns undefined when the index is out of range even for a matching-size surface", () => {
    const surface = makeSurface(12);
    expect(projectMaturity(surface, 99, 12)).toBeUndefined();
  });
});

// ─── projectSurfaceSnapshot ──────────────────────────────────────────────────

describe("projectSurfaceSnapshot — staleness filter", () => {
  it("returns the slice when expectedSurfaceSize matches", () => {
    const snapshot = {
      slices: Array.from({ length: 12 }, (_, i) => makeSlice(0.1 + i * 0.1)),
      trueParamsPerSlice: Array.from({ length: 12 }, () => makeParams()),
      tickIndex: 1,
    };
    const result = projectSurfaceSnapshot(snapshot, 5, 12);
    expect(result).toBeDefined();
    expect(result?.slice.timeToExpiry).toBeCloseTo(0.6, 6);
  });

  it("returns undefined when the snapshot is stale (length mismatch)", () => {
    const staleSnapshot = {
      slices: Array.from({ length: 70 }, (_, i) => makeSlice(0.02 + i * 0.04)),
      trueParamsPerSlice: Array.from({ length: 70 }, () => makeParams()),
      tickIndex: 1,
    };
    const result = projectSurfaceSnapshot(staleSnapshot, 5, 12);
    expect(result).toBeUndefined();
  });

  it("returns the slice when expectedSurfaceSize is omitted (legacy callers)", () => {
    const snapshot = {
      slices: [makeSlice(0.1), makeSlice(0.2)],
      trueParamsPerSlice: [makeParams(), makeParams()],
      tickIndex: 1,
    };
    const result = projectSurfaceSnapshot(snapshot, 0);
    expect(result).toBeDefined();
  });

  it("returns undefined when snapshot is undefined", () => {
    expect(projectSurfaceSnapshot(undefined, 0, 12)).toBeUndefined();
  });
});
