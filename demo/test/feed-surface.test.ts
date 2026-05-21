// Block 3.1 — synthetic surface feed.
//
// Verifies:
//   1. The TRUE surface (per-slice trueParams) is calendar-arb-free at
//      every emitted tick — the construction `a_T = a* · T` with b/ρ/m/σ
//      shared makes adjacent slices differ only by a·ΔT > 0 at every k.
//   2. Per-slice fits recover the true global parameters within 5 % over
//      a 100-tick sample. The independent per-(k, T) IV noise produces
//      observed quotes that don't perfectly match the underlying surface;
//      the LM fit averages out the noise.
//
// Together these establish the feed is a sound generator: the failure
// mode the demo shows (Form 2 composition incoherence at 70 × 200) is
// structural, not a feed artefact.

import { describe, expect, it } from "vitest";

import {
  buildExpiryLadder,
  buildStrikeGrid,
  SyntheticFeed,
} from "../src/feed.js";
import { fitSviSlice } from "../src/svi/fitter.js";
import { calendarCheck, repairCalendarArb } from "../src/svi/no-arb.js";

describe("SyntheticFeed (Block 3.1)", () => {
  it("default config matches Block 1.1 closure (70 × 200)", () => {
    const feed = new SyntheticFeed();
    expect(feed.getMaturities()).toHaveLength(70);
    expect(feed.getStrikes()).toHaveLength(200);
    const tick = feed.step();
    expect(tick.slices).toHaveLength(70);
    expect(tick.trueParamsPerSlice).toHaveLength(70);
    for (const slice of tick.slices) {
      expect(slice.quotes).toHaveLength(200);
    }
  });

  it("expiry ladder is monotone increasing from 1 week to 3 years", () => {
    const ladder = buildExpiryLadder(70);
    expect(ladder[0]).toBeCloseTo(7 / 365, 6);
    expect(ladder[ladder.length - 1]).toBeCloseTo(3.0, 6);
    for (let i = 1; i < ladder.length; i++) {
      const prev = ladder[i - 1] as number;
      const cur = ladder[i] as number;
      expect(cur).toBeGreaterThan(prev);
    }
  });

  it("strike grid spans ±50% log-moneyness uniformly", () => {
    const ks = buildStrikeGrid(200);
    expect(ks[0]).toBeCloseTo(-1.0, 6);
    expect(ks[ks.length - 1]).toBeCloseTo(1.0, 6);
    // Uniform spacing.
    const step = 2.0 / 199;
    for (let i = 1; i < ks.length; i++) {
      const prev = ks[i - 1] as number;
      const cur = ks[i] as number;
      expect(cur - prev).toBeCloseTo(step, 6);
    }
  });

  it("(plan §3.1) true surface is calendar-arb-free across 100 ticks", () => {
    // Smaller surface for test speed; the property is independent of size.
    const feed = new SyntheticFeed({
      nExpiriesFitted: 12,
      nStrikesPerSlice: 50,
      seed: 7,
    });
    const kGrid = buildStrikeGrid(50);
    for (let t = 0; t < 100; t++) {
      const tick = feed.step();
      const view = tick.trueParamsPerSlice.map((params, i) => {
        const slice = tick.slices[i];
        if (slice === undefined) throw new Error("missing slice");
        return { params, timeToExpiry: slice.timeToExpiry };
      });
      const result = calendarCheck(view, kGrid);
      if (!result.arbitrageFree) {
        // Provide actionable diagnostics if this ever fails: tick index +
        // first violation tuple.
        throw new Error(
          `tick ${t}: ${result.violations.length} violations; first ${JSON.stringify(result.violations[0])}`,
        );
      }
      expect(result.arbitrageFree).toBe(true);
      expect(result.minDelta).toBeGreaterThanOrEqual(0);
    }
  });

  it("(plan §3.1) per-slice fit recovers global params within 5 % across 100 ticks", () => {
    // The fitter sees observed (noisy) quotes per slice and recovers
    // per-slice params; under the T-scaling construction, all slices share
    // the same b/ρ/m/σ at every tick (only `a` scales linearly with T).
    //
    // Test discipline: the 5-parameter LM fit on noisy synthetic data has
    // intrinsic per-slice per-tick noise of order 5–10 % on individual
    // parameters (the fit decomposes IV noise across all five parameter
    // directions). One slice on one tick is not a meaningful recovery
    // signal. Both averaging across slices (per-tick aggregate) AND across
    // ticks (sqrt-N noise reduction) are needed.
    //
    // Aggregation per tick:
    //   â*_t  = least-squares slope of a_T on T across slices (zero intercept)
    //   b̂*_t  = mean of fitted b across slices (true: shared b)
    //   ρ̂*_t  = mean of fitted ρ across slices
    //   m̂*_t  = mean of fitted m across slices
    //   σ̂*_t  = mean of fitted σ across slices
    //
    // Across 100 ticks: average the estimators, average the true values,
    // compare. Per-tick noise σ ~ 5 % drops to σ/√100 = 0.5 % at the
    // averaged level. The 5 % tolerance comfortably covers this plus
    // any systematic bias from the LM's level-constraint regularisation.
    const feed = new SyntheticFeed({
      nExpiriesFitted: 6,
      nStrikesPerSlice: 50,
      seed: 11,
    });

    let aHatSum = 0;
    let bHatSum = 0;
    let rhoHatSum = 0;
    let mHatSum = 0;
    let sigmaHatSum = 0;
    let aTrueSum = 0;
    let bTrueSum = 0;
    let rhoTrueSum = 0;
    let mTrueSum = 0;
    let sigmaTrueSum = 0;
    let tickCount = 0;

    const N_TICKS = 100;
    for (let t = 0; t < N_TICKS; t++) {
      const tick = feed.step();
      const ts: number[] = [];
      const aTs: number[] = [];
      const bs: number[] = [];
      const rhos: number[] = [];
      const ms: number[] = [];
      const sigmas: number[] = [];
      for (let i = 0; i < tick.slices.length; i++) {
        const slice = tick.slices[i];
        if (slice === undefined) continue;
        const fit = fitSviSlice(slice);
        if (!fit.ok) continue;
        ts.push(slice.timeToExpiry);
        aTs.push(fit.params.a);
        bs.push(fit.params.b);
        rhos.push(fit.params.rho);
        ms.push(fit.params.m);
        sigmas.push(fit.params.sigma);
      }
      if (ts.length === 0) continue;

      // Slope through origin: â* = Σ(t·a_t) / Σ(t²)
      let num = 0;
      let den = 0;
      for (let i = 0; i < ts.length; i++) {
        const T = ts[i] as number;
        const a = aTs[i] as number;
        num += T * a;
        den += T * T;
      }
      const aHat = den === 0 ? 0 : num / den;
      const bHat = bs.reduce((s, x) => s + x, 0) / bs.length;
      const rhoHat = rhos.reduce((s, x) => s + x, 0) / rhos.length;
      const mHat = ms.reduce((s, x) => s + x, 0) / ms.length;
      const sigmaHat = sigmas.reduce((s, x) => s + x, 0) / sigmas.length;

      const firstTruth = tick.trueParamsPerSlice[0];
      if (firstTruth === undefined) continue;
      const firstT = tick.slices[0]?.timeToExpiry;
      if (firstT === undefined) continue;
      const aTrueGlobal = firstTruth.a / firstT;

      aHatSum += aHat;
      bHatSum += bHat;
      rhoHatSum += rhoHat;
      mHatSum += mHat;
      sigmaHatSum += sigmaHat;
      aTrueSum += aTrueGlobal;
      bTrueSum += firstTruth.b;
      rhoTrueSum += firstTruth.rho;
      mTrueSum += firstTruth.m;
      sigmaTrueSum += firstTruth.sigma;
      tickCount += 1;
    }
    expect(tickCount).toBeGreaterThan(50);
    const aHatAvg = aHatSum / tickCount;
    const bHatAvg = bHatSum / tickCount;
    const rhoHatAvg = rhoHatSum / tickCount;
    const mHatAvg = mHatSum / tickCount;
    const sigmaHatAvg = sigmaHatSum / tickCount;
    const aTrueAvg = aTrueSum / tickCount;
    const bTrueAvg = bTrueSum / tickCount;
    const rhoTrueAvg = rhoTrueSum / tickCount;
    const mTrueAvg = mTrueSum / tickCount;
    const sigmaTrueAvg = sigmaTrueSum / tickCount;

    expect(Math.abs(aHatAvg - aTrueAvg) / Math.abs(aTrueAvg)).toBeLessThan(
      0.05,
    );
    expect(Math.abs(bHatAvg - bTrueAvg) / Math.abs(bTrueAvg)).toBeLessThan(
      0.05,
    );
    expect(
      Math.abs(rhoHatAvg - rhoTrueAvg) / Math.abs(rhoTrueAvg),
    ).toBeLessThan(0.05);
    // `m` anchor is 0; use additive error scaled by σ.
    expect(Math.abs(mHatAvg - mTrueAvg) / sigmaTrueAvg).toBeLessThan(0.05);
    expect(
      Math.abs(sigmaHatAvg - sigmaTrueAvg) / Math.abs(sigmaTrueAvg),
    ).toBeLessThan(0.05);
  });

  it("recovery survives the calendar-arb repair pass (Step A item 6)", () => {
    // The per-slice raw fit can produce calendar-arb violations from
    // noise; `repairCalendarArb` re-fits affected slices with a soft
    // floor. The re-fit BIASES the params (the LM trades data residual
    // against floor penalty). This test verifies that bias doesn't
    // exceed the 5 % envelope at the 100-tick aggregate level — i.e.
    // the demo's output remains a meaningful estimate of the underlying
    // surface after repair, not just after raw fit. Also asserts that
    // repair runs at least once during the 100-tick sweep so the test
    // is meaningfully exercising the repair path.
    // Use elevated noise (σ = 0.005) explicitly to exercise the repair
    // path. The feed default is 0.001 (SPX-ATM-realistic) which produces
    // an essentially arb-free synthetic surface — the recovery+repair
    // contract is only meaningful when repair actually runs.
    const feed = new SyntheticFeed({
      nExpiriesFitted: 6,
      nStrikesPerSlice: 50,
      seed: 19,
      ivNoise: 0.005,
    });
    const kGrid = buildStrikeGrid(50);

    let aHatSum = 0;
    let bHatSum = 0;
    let rhoHatSum = 0;
    let mHatSum = 0;
    let sigmaHatSum = 0;
    let aTrueSum = 0;
    let bTrueSum = 0;
    let rhoTrueSum = 0;
    let mTrueSum = 0;
    let sigmaTrueSum = 0;
    let tickCount = 0;
    let repairsThisRun = 0;
    let repairFailedThisRun = 0;

    const N_TICKS = 100;
    for (let t = 0; t < N_TICKS; t++) {
      const tick = feed.step();
      const rawFits = tick.slices.map((s) => fitSviSlice(s));
      const repair = repairCalendarArb(tick.slices, rawFits, kGrid);
      if (repair.surfaceArbStatus === "repair-applied") repairsThisRun += 1;
      if (repair.surfaceArbStatus === "repair-failed") repairFailedThisRun += 1;

      const ts: number[] = [];
      const aTs: number[] = [];
      const bs: number[] = [];
      const rhos: number[] = [];
      const ms: number[] = [];
      const sigmas: number[] = [];
      for (let i = 0; i < tick.slices.length; i++) {
        const slice = tick.slices[i];
        const fit = repair.fitResults[i];
        if (slice === undefined || fit === undefined || !fit.ok) continue;
        ts.push(slice.timeToExpiry);
        aTs.push(fit.params.a);
        bs.push(fit.params.b);
        rhos.push(fit.params.rho);
        ms.push(fit.params.m);
        sigmas.push(fit.params.sigma);
      }
      if (ts.length === 0) continue;

      let num = 0;
      let den = 0;
      for (let i = 0; i < ts.length; i++) {
        const T = ts[i] as number;
        const a = aTs[i] as number;
        num += T * a;
        den += T * T;
      }
      const aHat = den === 0 ? 0 : num / den;
      const bHat = bs.reduce((s, x) => s + x, 0) / bs.length;
      const rhoHat = rhos.reduce((s, x) => s + x, 0) / rhos.length;
      const mHat = ms.reduce((s, x) => s + x, 0) / ms.length;
      const sigmaHat = sigmas.reduce((s, x) => s + x, 0) / sigmas.length;

      const firstTruth = tick.trueParamsPerSlice[0];
      if (firstTruth === undefined) continue;
      const firstT = tick.slices[0]?.timeToExpiry;
      if (firstT === undefined) continue;
      const aTrueGlobal = firstTruth.a / firstT;

      aHatSum += aHat;
      bHatSum += bHat;
      rhoHatSum += rhoHat;
      mHatSum += mHat;
      sigmaHatSum += sigmaHat;
      aTrueSum += aTrueGlobal;
      bTrueSum += firstTruth.b;
      rhoTrueSum += firstTruth.rho;
      mTrueSum += firstTruth.m;
      sigmaTrueSum += firstTruth.sigma;
      tickCount += 1;
    }
    expect(tickCount).toBeGreaterThan(50);
    // Diagnostic: confirm the repair path was actually exercised.
    expect(repairsThisRun + repairFailedThisRun).toBeGreaterThan(0);

    const aHatAvg = aHatSum / tickCount;
    const bHatAvg = bHatSum / tickCount;
    const rhoHatAvg = rhoHatSum / tickCount;
    const mHatAvg = mHatSum / tickCount;
    const sigmaHatAvg = sigmaHatSum / tickCount;
    const aTrueAvg = aTrueSum / tickCount;
    const bTrueAvg = bTrueSum / tickCount;
    const rhoTrueAvg = rhoTrueSum / tickCount;
    const mTrueAvg = mTrueSum / tickCount;
    const sigmaTrueAvg = sigmaTrueSum / tickCount;

    expect(Math.abs(aHatAvg - aTrueAvg) / Math.abs(aTrueAvg)).toBeLessThan(
      0.05,
    );
    expect(Math.abs(bHatAvg - bTrueAvg) / Math.abs(bTrueAvg)).toBeLessThan(
      0.05,
    );
    expect(
      Math.abs(rhoHatAvg - rhoTrueAvg) / Math.abs(rhoTrueAvg),
    ).toBeLessThan(0.05);
    expect(Math.abs(mHatAvg - mTrueAvg) / sigmaTrueAvg).toBeLessThan(0.05);
    expect(
      Math.abs(sigmaHatAvg - sigmaTrueAvg) / Math.abs(sigmaTrueAvg),
    ).toBeLessThan(0.05);
  });

  it("emits deterministic byte-identical sequence for the same seed", () => {
    const feed1 = new SyntheticFeed({
      nExpiriesFitted: 3,
      nStrikesPerSlice: 5,
      seed: 17,
    });
    const feed2 = new SyntheticFeed({
      nExpiriesFitted: 3,
      nStrikesPerSlice: 5,
      seed: 17,
    });
    for (let t = 0; t < 10; t++) {
      const t1 = feed1.step();
      const t2 = feed2.step();
      expect(t1.spot).toBe(t2.spot);
      expect(t1.tickIndex).toBe(t2.tickIndex);
      for (let i = 0; i < t1.slices.length; i++) {
        const s1 = t1.slices[i];
        const s2 = t2.slices[i];
        if (s1 === undefined || s2 === undefined) continue;
        expect(s1.timeToExpiry).toBe(s2.timeToExpiry);
        for (let j = 0; j < s1.quotes.length; j++) {
          expect(s1.quotes[j]?.impliedVol).toBe(s2.quotes[j]?.impliedVol);
        }
      }
    }
  });

  it("shock multiplier accelerates parameter drift", () => {
    const baselineFeed = new SyntheticFeed({
      nExpiriesFitted: 6,
      nStrikesPerSlice: 50,
      seed: 23,
    });
    const shockFeed = new SyntheticFeed({
      nExpiriesFitted: 6,
      nStrikesPerSlice: 50,
      seed: 23,
      shockMultiplier: 5,
    });

    // Run 50 ticks each; measure how far the true `b` parameter has
    // drifted from the anchor (0.1). Shock should produce > baseline drift.
    let baselineDrift = 0;
    let shockDrift = 0;
    for (let t = 0; t < 50; t++) {
      const baseTick = baselineFeed.step();
      const shockTick = shockFeed.step();
      const baseFirst = baseTick.trueParamsPerSlice[0];
      const shockFirst = shockTick.trueParamsPerSlice[0];
      if (baseFirst !== undefined) {
        baselineDrift = Math.max(baselineDrift, Math.abs(baseFirst.b - 0.1));
      }
      if (shockFirst !== undefined) {
        shockDrift = Math.max(shockDrift, Math.abs(shockFirst.b - 0.1));
      }
    }
    expect(shockDrift).toBeGreaterThan(baselineDrift);
  });

  it("setMaturityCount preserves OU state (Fix A regression)", () => {
    // The expiry-count selector reshapes the ladder without resetting the
    // OU walk. If this regresses, the next refactor that goes back to
    // reconstructing the feed on every config change would silently lose
    // Fix A — the visible failure is "smile snaps to anchor every time
    // the user changes count," which is mistaken for a state bug.
    const feed = new SyntheticFeed({
      seed: 42,
      nExpiriesFitted: 70,
      nStrikesPerSlice: 50,
    });

    // Step many times to let the OU walk drift the global params well
    // away from the anchor (~PER_TICK_DIFFUSION × √500 for any param).
    for (let i = 0; i < 500; i += 1) feed.step();

    const beforeTick = feed.step();
    const beforeParams = beforeTick.trueParamsPerSlice[0];
    if (beforeParams === undefined)
      throw new Error("expected at least one slice");
    const beforeTickIndex = beforeTick.tickIndex;
    const beforeSpot = beforeTick.spot;

    // Reshape the ladder.
    feed.setMaturityCount(12);
    expect(feed.getMaturities()).toHaveLength(12);

    const afterTick = feed.step();
    const afterParams = afterTick.trueParamsPerSlice[0];
    if (afterParams === undefined)
      throw new Error("expected at least one slice");

    // Tick index keeps advancing — proves no reset.
    expect(afterTick.tickIndex).toBe(beforeTickIndex + 1);

    // Global params (non-T-scaled `b`, `ρ`, `m`, `σ`) drift by ≤ a few
    // PER_TICK_DIFFUSION's between consecutive ticks — far closer than
    // the post-anchor reset distance (~10× larger). Verify they're
    // within the per-tick drift envelope, not snapped back to anchor.
    expect(Math.abs(afterParams.b - beforeParams.b)).toBeLessThan(0.02);
    expect(Math.abs(afterParams.rho - beforeParams.rho)).toBeLessThan(0.05);
    expect(Math.abs(afterParams.m - beforeParams.m)).toBeLessThan(0.05);
    expect(Math.abs(afterParams.sigma - beforeParams.sigma)).toBeLessThan(0.05);

    // Spot path is also continuous (GBM step uses the same `this.spot`).
    // A single GBM step at σ_spot=0.20, Δt=1/(252·50) moves at most a
    // few percent of spot in one tick; ~50 % drift would indicate reset.
    expect(Math.abs(afterTick.spot / beforeSpot - 1)).toBeLessThan(0.05);
  });

  it("constructor throws if per-tick noise demand exceeds the pool size", () => {
    // The pool is sized to fit one tick's worth of per-quote noise draws
    // (default 16 384, > 80 × 200 = 16 000 max under current UI ceilings).
    // A future change that exposes a larger surface configuration would
    // wrap the cursor within a tick and produce identical noise on
    // adjacent strikes. The constructor guards against this by throwing.
    expect(
      () =>
        new SyntheticFeed({
          seed: 1,
          // 100 × 200 = 20 000 > 16 384.
          nExpiriesFitted: 100,
          nStrikesPerSlice: 200,
        }),
    ).toThrowError(/noise demand .* exceeds pool size/);
  });

  it("setMaturityCount throws if the new ladder size exceeds the pool", () => {
    const feed = new SyntheticFeed({
      seed: 1,
      nExpiriesFitted: 12,
      nStrikesPerSlice: 200,
    });
    // 12 × 200 = 2 400 — within budget.
    // setMaturityCount(100) would push per-tick demand to 100 × 200 = 20 000.
    expect(() => feed.setMaturityCount(100)).toThrowError(
      /noise demand .* exceeds pool size/,
    );
  });
});
