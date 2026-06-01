import { describe, expect, it } from "vitest";

import { buildExpiryLadder } from "../src/feed.js";
import { fitSviSlice } from "../src/svi/fitter.js";
import { repairCalendarArb } from "../src/svi/no-arb.js";
import type { SviParams } from "../src/svi/params.js";
import { validateParams } from "../src/svi/params.js";
import type { Slice } from "../src/svi/svi.js";
import { varianceToIv, w } from "../src/svi/svi.js";

function fixture(
  a: number,
  b: number,
  rho: number,
  m: number,
  sigma: number,
): SviParams {
  const r = validateParams({ a, b, rho, m, sigma });
  if (!r.ok) throw new Error("fixture invalid");
  return r.params;
}

function buildSlice(nStrikes: number, T: number, truth: SviParams): Slice {
  const ks = Array.from(
    { length: nStrikes },
    (_, i) => -1.0 + (i / (nStrikes - 1)) * 2.0,
  );
  const quotes = ks.map((k) => ({
    logMoneyness: k,
    impliedVol: varianceToIv(w(k, truth), T),
  }));
  return { quotes, timeToExpiry: T };
}

const TRUTH = fixture(0.04, 0.1, -0.5, 0.0, 0.2);

type Timings = { p99: number; max: number; mean: number };

/**
 * Returns p99, max, and mean of N runs in milliseconds. Warms up via 5
 * untimed runs to amortise V8 baseline-tier compilation. The max measure
 * captures GC-pause and other tail effects that p99 misses on a 50-run
 * sample — load-bearing for the streaming-use claim where ANY single fit
 * exceeding the inter-snapshot interval breaks render coherence.
 */
function timeRuns(fn: () => unknown, runs = 50): Timings {
  for (let i = 0; i < 5; i++) fn();
  const timings: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    timings.push(performance.now() - t0);
  }
  const sorted = timings.slice().sort((a, b) => a - b);
  const p99Idx = Math.floor(runs * 0.99);
  const p99 = sorted[p99Idx] ?? sorted[runs - 1] ?? 0;
  const max = timings.reduce((m, t) => (t > m ? t : m), 0);
  const sum = timings.reduce((s, t) => s + t, 0);
  return { p99, max, mean: sum / runs };
}

// Coarse CI-friendly budgets. For the larger workloads (200-strike,
// surface, 70×200) the p99 budget is ~3× the bench-authoritative target
// in `demo/bench/svi.bench.ts` — enough headroom to absorb CI-host
// variance and GC pauses while still catching gross regressions (a 2×
// slowdown would trip).
//
// For the smaller workloads (10-strike, 50-strike) the noise floor is
// disproportionately large: the bench p99 is sub-millisecond but a
// single GC pause or vitest-worker contention spike on a busy macOS
// shell can push p99 into the 20–40 ms range, generating false-positive
// CI flakes (the bench is run dedicated; CI is shared). Budgets here
// are widened to absorb that tail. They're catching "obviously
// catastrophic" regressions only (100×+ slowdown) — the load-bearing
// gates are at 200-strike and 70×200 where the workload is large
// enough that noise stops dominating.
//
// The max budget is wider than p99 because a single GC-pause sample
// can spike to multiples of mean; max captures tail events that p99
// misses on a 50-run sample.
const BUDGETS_MS = {
  s10: { p99: 50, max: 150 }, // bench p99 ~0.17 ms; widened for small-workload noise
  s50: { p99: 60, max: 200 }, // bench p99 ~0.52 ms; widened for small-workload noise
  s200: { p99: 120, max: 400 }, // bench p99 ~1.85 ms
  surface: { p99: 750, max: 2500 }, // bench p99 ~2.81 ms (Phase 2: 50 × 6)
  // Phase 3.5 70 × 200 reference surface — fits + calendar-arb check.
  // (50 × 200 is the runtime default since 2026-05-25; 70 × 200 remains
  // the canonical perf-gate target.) Local bench p99 warm sits at ~82 ms
  // on M-series Mac, within ~10 % of the original 2026-05-21 baseline
  // (~75 ms). The GitHub Actions `ubuntu-latest` CI runner (2-core,
  // shared) runs the same workload ~3–5× slower with single-fit outliers
  // up to ~400 ms observed under runner-pool contention. The 750 ms
  // budget is ~9× the current bench baseline, sized to absorb CI
  // variance without false flakes; still catches catastrophic
  // regressions. Authoritative perf signal is `demo/bench/svi.bench.ts`,
  // not this gate.
  s70x200: { p99: 750, max: 2000 },
} as const;

describe("SVI fit — performance gates", () => {
  it("10-strike fit p99 + max < coarse-CI budgets", () => {
    const slice = buildSlice(10, 1.0, TRUTH);
    const { p99, max } = timeRuns(() => fitSviSlice(slice));
    expect(p99).toBeLessThan(BUDGETS_MS.s10.p99);
    expect(max).toBeLessThan(BUDGETS_MS.s10.max);
  });

  it("50-strike fit p99 + max < coarse-CI budgets", () => {
    const slice = buildSlice(50, 1.0, TRUTH);
    const { p99, max } = timeRuns(() => fitSviSlice(slice));
    expect(p99).toBeLessThan(BUDGETS_MS.s50.p99);
    expect(max).toBeLessThan(BUDGETS_MS.s50.max);
  });

  it("200-strike fit p99 + max < coarse-CI budgets", () => {
    const slice = buildSlice(200, 1.0, TRUTH);
    const { p99, max } = timeRuns(() => fitSviSlice(slice), 30);
    expect(p99).toBeLessThan(BUDGETS_MS.s200.p99);
    expect(max).toBeLessThan(BUDGETS_MS.s200.max);
  });

  it("full surface (50 × 6) p99 + max < coarse-CI budgets", () => {
    const Ts = [0.083, 0.25, 0.5, 1.0, 1.5, 2.0];
    const slices = Ts.map((T) => buildSlice(50, T, TRUTH));
    const { p99, max } = timeRuns(() => {
      for (const s of slices) fitSviSlice(s);
    }, 20);
    expect(p99).toBeLessThan(BUDGETS_MS.surface.p99);
    expect(max).toBeLessThan(BUDGETS_MS.surface.max);
  });

  // Phase 3.5: 70×200 production-realistic surface — per-slice fits +
  // calendar-arb detection. Models the demo's default tick. Uses calendar-
  // arb-free synthetic input (a*·T per slice; other params shared) so the
  // repair pass exits at detection — happy-path compute, matching the
  // bench-file scenario. Stress-with-repair cost lives in the bench, not
  // here (CI gate is for "is the floor still ~75 ms?", not for measuring
  // the repair budget).
  //
  // Per-test timeout widened to 60 s because the 15 total runs (5 warmup +
  // 10 measured) at ~400 ms per-run worst-case on `ubuntu-latest` would
  // otherwise blow past vitest's 5 s default. The timeout is "give the
  // test enough room to complete and let the budget gate fail honestly";
  // the gate itself (p99 < 750 ms, max < 2000 ms) is what catches real
  // regressions.
  it("Phase 3.5 surface (70 × 200) p99 + max < coarse-CI budgets", () => {
    const ladder = buildExpiryLadder(70);
    const slices = ladder.map((T) =>
      buildSlice(
        200,
        T,
        fixture(0.04 * T, TRUTH.b, TRUTH.rho, TRUTH.m, TRUTH.sigma),
      ),
    );
    const kGrid = Array.from({ length: 200 }, (_, i) => -1.0 + (2.0 * i) / 199);
    const { p99, max } = timeRuns(() => {
      const fits = slices.map((s) => fitSviSlice(s));
      repairCalendarArb(slices, fits, kGrid);
    }, 10);
    expect(p99).toBeLessThan(BUDGETS_MS.s70x200.p99);
    expect(max).toBeLessThan(BUDGETS_MS.s70x200.max);
  }, 60_000);
});
