// Regression tests for the per-mode lag formula in `demo/src/metrics.ts`.
//
// Locks in the fix from DEMO_METRIC_FIX_PLAN.md Phases 1 and 2:
//
//   - NAIVE uses Math.abs(latestInputs - data) because the displayed
//     (dots, curve) pair can have data either ahead of or behind the
//     input view depending on load regime. Pre-fix used max(0, current
//     - data) which clamped one of the two directions to zero, hiding
//     the failure mode at light load.
//
//   - GATED keeps max(0, currentTickIndex - data) because the substrate's
//     atomic commit makes (latestInputs.tickIndex === data.sourceTickIndex)
//     identically; the only meaningful lag is staleness relative to the
//     feed's latest tick. Substrate cannot commit a fit ahead of its
//     own source, so the clamp is correct.
//
// If either of these regresses, the demo's instrumentation goes back to
// reading dishonestly — `lag=0t + mismark=high` reappears on naive at
// Scenario 0 and the trader-facing credibility collapses.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { computeSnapshotLag } from "../src/metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("computeSnapshotLag — naive mode", () => {
  it("measures absolute structural gap between latestInputs and data", () => {
    // Heavy-load case: worker queue saturated, data lags input.
    expect(
      computeSnapshotLag("naive", {
        latestInputsTickIndex: 100,
        dataSourceTickIndex: 60,
        currentTickIndex: undefined,
      }),
    ).toBe(40);

    // Light-load case: eager setData runs ahead of the 5 Hz throttled
    // input view. This is the case the pre-fix formula was clamping
    // to zero (max(0, currentTickIndex - data) hides negative results).
    expect(
      computeSnapshotLag("naive", {
        latestInputsTickIndex: 60,
        dataSourceTickIndex: 100,
        currentTickIndex: undefined,
      }),
    ).toBe(40);

    // Exact tick match → no structural gap.
    expect(
      computeSnapshotLag("naive", {
        latestInputsTickIndex: 100,
        dataSourceTickIndex: 100,
        currentTickIndex: undefined,
      }),
    ).toBe(0);
  });

  it("ignores currentTickIndex for naive — only latestInputs counts", () => {
    // Naive's mismark / red-dot diagnostic derives from
    // latestInputs.trueParams (NOT currentTickIndex's truth). The lag
    // metric must use the same reference so the chip and the diagnostic
    // can't contradict each other. This is the load-bearing invariant.
    const withDifferentCurrent = computeSnapshotLag("naive", {
      latestInputsTickIndex: 100,
      dataSourceTickIndex: 95,
      currentTickIndex: 110, // ← if this were used, lag would differ
    });
    expect(withDifferentCurrent).toBe(5);

    // Same M, D, different currentTickIndex still gives same lag.
    const withZeroCurrent = computeSnapshotLag("naive", {
      latestInputsTickIndex: 100,
      dataSourceTickIndex: 95,
      currentTickIndex: 0,
    });
    expect(withZeroCurrent).toBe(5);
  });

  it("returns undefined when required inputs are missing", () => {
    expect(
      computeSnapshotLag("naive", {
        latestInputsTickIndex: undefined,
        dataSourceTickIndex: undefined,
        currentTickIndex: undefined,
      }),
    ).toBeUndefined();
    expect(
      computeSnapshotLag("naive", {
        latestInputsTickIndex: undefined,
        dataSourceTickIndex: 100,
        currentTickIndex: undefined,
      }),
    ).toBeUndefined();
    expect(
      computeSnapshotLag("naive", {
        latestInputsTickIndex: 100,
        dataSourceTickIndex: undefined,
        currentTickIndex: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("computeSnapshotLag — gated mode", () => {
  it("measures staleness clamped at zero", () => {
    // Substrate's coherent snapshot is N ticks behind the feed's latest
    // → lag = N. Normal case at heavy load and during compute.
    expect(
      computeSnapshotLag("gated", {
        latestInputsTickIndex: undefined,
        dataSourceTickIndex: 60,
        currentTickIndex: 100,
      }),
    ).toBe(40);

    // Substrate cannot commit a fit ahead of its source tick — but if
    // the throttled feed.tick falls behind the eager substrate commit
    // (rare, but plausible at the 5 Hz throttle boundary), we clamp at
    // zero rather than report a negative "lag". Reporting negative
    // would be confusing — gated lag has unambiguous semantics
    // ("how stale is the displayed coherent snapshot vs the feed's
    // latest visible tick") and is non-negative by construction.
    expect(
      computeSnapshotLag("gated", {
        latestInputsTickIndex: undefined,
        dataSourceTickIndex: 100,
        currentTickIndex: 60,
      }),
    ).toBe(0);

    // Exact match.
    expect(
      computeSnapshotLag("gated", {
        latestInputsTickIndex: undefined,
        dataSourceTickIndex: 100,
        currentTickIndex: 100,
      }),
    ).toBe(0);
  });

  it("ignores latestInputsTickIndex — substrate guarantees coherence", () => {
    // For gated, latestInputs IS derived from data (atomic commit
    // invariant). Their tickIndexes are identical by construction.
    // The lag formula uses currentTickIndex - data, not latestInputs -
    // data, because the meaningful question is "how stale is the
    // coherent snapshot vs real time", not "what's the gap between
    // dots and curve" (which is zero on gated).
    const result1 = computeSnapshotLag("gated", {
      latestInputsTickIndex: 50, // ← if this were used, lag would be 50
      dataSourceTickIndex: 100,
      currentTickIndex: 100,
    });
    expect(result1).toBe(0); // currentTickIndex - data = 0

    const result2 = computeSnapshotLag("gated", {
      latestInputsTickIndex: 999,
      dataSourceTickIndex: 100,
      currentTickIndex: 105,
    });
    expect(result2).toBe(5); // 105 - 100, ignoring latestInputs
  });

  it("returns undefined when required inputs are missing", () => {
    expect(
      computeSnapshotLag("gated", {
        latestInputsTickIndex: undefined,
        dataSourceTickIndex: undefined,
        currentTickIndex: 100,
      }),
    ).toBeUndefined();
    expect(
      computeSnapshotLag("gated", {
        latestInputsTickIndex: undefined,
        dataSourceTickIndex: 100,
        currentTickIndex: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("metric coherence invariant — chip and lag cannot silently contradict", () => {
  // The trader-credibility property: at any moment, the naive lag
  // metric and the visible-tear diagnostic (mismark / red dots) must
  // derive from the same (latestInputs, data) pair. If they reference
  // different sources, you get the pre-fix bug where lag reads 0
  // while mismark is elevated and the chart is visibly torn —
  // contradictory instrumentation that traders rightly distrust.
  //
  // This test asserts the property structurally: given any
  // (latestInputs.tickIndex, data.sourceTickIndex) pair, the formula
  // reports the magnitude exactly. The diagnostic that drives mismark
  // uses the same pair (see Panel.tsx — both `dotsTrueParams` from
  // latestInputs.trueParams and `fitParams` from data.fitResult.params
  // come from the same projection). So mismark > 0 implies the
  // params differ → the params came from different ticks → lag > 0.

  it("naive lag is non-zero whenever the (latestInputs, data) snapshot pair disagrees in tick", () => {
    const pairs: Array<[number, number]> = [
      [100, 50], // heavy: data behind
      [50, 100], // light: data ahead
      [100, 99], // 1-tick reverse drift
      [99, 100], // 1-tick forward drift
      [1, 0], // smallest possible drift
    ];
    for (const [M, D] of pairs) {
      const lag = computeSnapshotLag("naive", {
        latestInputsTickIndex: M,
        dataSourceTickIndex: D,
        currentTickIndex: undefined,
      });
      expect(lag).toBe(Math.abs(M - D));
      expect(lag).toBeGreaterThan(0);
    }
  });

  it("naive lag is zero only when the snapshot pair is from the same tick", () => {
    const lag = computeSnapshotLag("naive", {
      latestInputsTickIndex: 100,
      dataSourceTickIndex: 100,
      currentTickIndex: undefined,
    });
    expect(lag).toBe(0);
  });
});

describe("source-identity locks", () => {
  // These tests catch a class of regression that the unit tests above
  // don't: if a future contributor reintroduces the bare lag formula
  // inline in Panel.tsx or App.tsx instead of delegating to
  // computeSnapshotLag, the unit tests still pass but the per-mode
  // invariant can quietly diverge between call sites. Reading the
  // source for the canonical helper call asserts both files delegate.

  it("Panel.tsx delegates lag computation to computeSnapshotLag", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/components/Panel.tsx"),
      "utf8",
    );
    expect(src).toMatch(/computeSnapshotLag\(/);
    // No bare arithmetic on `currentTickIndex - data.sourceTickIndex`
    // outside the helper. (The helper itself lives in metrics.ts so
    // any occurrence in Panel.tsx would be a duplicate-inline bug.)
    expect(src).not.toMatch(
      /Math\.max\(0,\s*currentTickIndex\s*-\s*data[?.]+sourceTickIndex/,
    );
    expect(src).not.toMatch(
      /Math\.abs\(latestInputs[?.]+tickIndex\s*-\s*data[?.]+sourceTickIndex/,
    );
  });

  it("App.tsx delegates lag computation to computeSnapshotLag", () => {
    const src = readFileSync(resolve(__dirname, "../src/App.tsx"), "utf8");
    expect(src).toMatch(/computeSnapshotLag\(/);
    // No bare arithmetic on a tickIndex subtraction in any single
    // line. Per-line check avoids matching across unrelated
    // `Math.max(0, ...)` uses elsewhere in the file (chart Y-axis
    // padding, etc.).
    const lines = src.split("\n");
    for (const line of lines) {
      expect(line).not.toMatch(/currentTickIndex\s*-\s*[\w.?]*sourceTickIndex/);
      expect(line).not.toMatch(
        /[\w.?]+TickIndex\s*-\s*[\w.?]+\.sourceTickIndex/,
      );
    }
  });
});
