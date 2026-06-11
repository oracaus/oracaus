// Per-strike mismark computation, shared by OptionChainTable (rows +
// aggregate) and MismarkSparkline (aggregate only). The math is trivial
// per slice (one SVI evaluation per strike), so memoising at each call
// site rather than lifting state is fine.

import type { SviParams } from "./svi/params.js";
import type { Slice } from "./svi/svi.js";
import { w } from "./svi/svi.js";

export type PanelData = {
  readonly slice: Slice | undefined;
  readonly params: SviParams | undefined;
};

/**
 * Panel data for the ground-truth fit error — the fit measured against the
 * TRUE surface at its own snapshot, rather than against the observed quotes.
 * `slice` and `trueParams` must come from the SAME committed snapshot as
 * `params` (i.e. `data.sourceSlice` / `data.sourceTrueParams`), not the
 * current tick — otherwise this measures the staleness tear, not fit quality.
 */
export type GroundTruthPanelData = {
  readonly slice: Slice | undefined;
  readonly params: SviParams | undefined;
  readonly trueParams: SviParams | undefined;
};

export type MissRow = {
  readonly k: number;
  /** Difference fit-IV − observed-IV at this strike, in IV points. */
  readonly miss: number | undefined;
};

export type MissSummary = {
  readonly sum: number;
  readonly max: number;
};

export function computeMisses(data: PanelData): MissRow[] {
  if (data.slice === undefined || data.params === undefined) return [];
  const params = data.params;
  const slice = data.slice;
  return slice.quotes.map((q) => {
    const wFit = w(q.logMoneyness, params);
    const fitIv = Math.sqrt(Math.max(0, wFit) / slice.timeToExpiry);
    return { k: q.logMoneyness, miss: fitIv - q.impliedVol };
  });
}

/**
 * Ground-truth fit error: fit curve vs the TRUE surface at the fit's own
 * snapshot, per strike, in IV points. Unlike `computeMisses` (fit vs the
 * *observed* quotes), this measures how well the fitter recovered the
 * underlying params from noisy quotes — so it reads ~equal on both panels
 * and does not move under the vol shock. It is the LM residual against
 * truth, not the staleness tear. The article's "ground-truth fit error".
 */
export function computeTruthMisses(data: GroundTruthPanelData): MissRow[] {
  if (
    data.slice === undefined ||
    data.params === undefined ||
    data.trueParams === undefined
  ) {
    return [];
  }
  const { slice, params, trueParams } = data;
  return slice.quotes.map((q) => {
    const fitIv = Math.sqrt(
      Math.max(0, w(q.logMoneyness, params)) / slice.timeToExpiry,
    );
    const trueIv = Math.sqrt(
      Math.max(0, w(q.logMoneyness, trueParams)) / slice.timeToExpiry,
    );
    return { k: q.logMoneyness, miss: fitIv - trueIv };
  });
}

export function summariseMisses(
  rows: ReadonlyArray<MissRow>,
): MissSummary | undefined {
  let sum = 0;
  let max = 0;
  let n = 0;
  for (const row of rows) {
    if (row.miss === undefined) continue;
    const abs = Math.abs(row.miss);
    sum += abs;
    if (abs > max) max = abs;
    n += 1;
  }
  return n === 0 ? undefined : { sum, max };
}
