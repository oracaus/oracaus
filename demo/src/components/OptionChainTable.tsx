// Option-chain right rail. Per-strike mismark (curve evaluated at strike
// vs. the dot rendered at that strike, in each panel) as a numeric
// companion to the smile charts.
//
// Layout: full-height flex column inside its parent rail.
//   - Hero card (pinned, shrink-0): NAIVE Σ|miss| / max above ORACAUS —
//     the headline number-vs-number contrast.
//   - Section label (pinned, shrink-0).
//   - Per-strike rows (scrollable, flex-1 min-h-0 overflow-y-auto):
//     log-moneyness + NAIVE miss + ORACAUS miss per row, sticky thead.
//
// Row count is `nStrikesPerSlice` (default 200). Native CSS overflow-y-auto
// scrolling beats virtualization at this row count: 200 DOM rows × the
// 5 Hz throttled re-render via `React.memo` + the throttled props from
// App.tsx is well within budget, and a virtualized table would force a
// `<div>` flexbox layout instead of the native `<table>` semantics
// traders read fluently.
//
// `[contain:layout_style]` isolates the table's layout work from the
// rest of the page.

import { memo, useMemo } from "react";

import {
  computeMisses,
  computeTruthMisses,
  type GroundTruthPanelData,
  type PanelData,
  summariseMisses,
} from "../svi-mismark.js";

const BAR_FULL_SCALE_IV = 0.1;
const SIGNIFICANT_MISS_THRESHOLD = 0.005;

// Tolerance for matching a continuous hovered k (from smile pointer move)
// to a discrete row. Mirrors `NEAREST_QUOTE_K_TOLERANCE` in `Smile.tsx`:
// ±0.02 covers ~2 strike widths at the demo's 200-strikes-over-[-1,1]
// geometry. Outside that band, smile hover does not highlight a row.
const NEAREST_ROW_K_TOLERANCE = 0.02;

export type { PanelData };

export type OptionChainTableProps = {
  readonly naive: PanelData;
  readonly gated: PanelData;
  /**
   * Ground-truth fit error inputs — the committed fit measured against the
   * TRUE surface at its own snapshot, per panel. Reads ~equal on both panels
   * and unmoved by the shock (the fitter's residual, not the tear), so it is
   * the falsifiable companion to the divergent coherence number above.
   */
  readonly naiveTruth: GroundTruthPanelData;
  readonly gatedTruth: GroundTruthPanelData;
  /**
   * Cross-view hover state — log-moneyness currently hovered in either
   * smile or here. App-owned. When non-null and matching a row's `k`,
   * that row renders with the hover highlight, mirroring the dashed
   * cursor line on both smile panels.
   */
  readonly hoveredK: number | null;
  /**
   * Setter for the cross-view hover state. Row pointer-enter sets to the
   * row's `k`; a single pointer-leave on the `<tbody>` clears to `null`.
   */
  readonly onHoverChange: (k: number | null) => void;
};

type Row = {
  readonly k: number;
  readonly naiveMiss: number | undefined;
  readonly gatedMiss: number | undefined;
};

// MissCell renders the SAME DOM structure regardless of data state.
// The pre-data branch used to omit the severity bar div and drop the
// `relative` positioning on the td — those structural differences
// caused subpixel layout shifts on first data arrival (registered as
// CLS). Flattened: one `<td>` shape, one severity bar element, one
// value span. All state differences are encoded in style values
// (opacity, transform.scaleX, text content, text colour) — none of
// which trigger layout.
function MissCell({ miss }: { miss: number | undefined }) {
  const isDefined = miss !== undefined;
  const abs = isDefined ? Math.abs(miss) : 0;
  const isSignificant = isDefined && abs >= SIGNIFICANT_MISS_THRESHOLD;
  const barScale = isDefined ? Math.min(1, abs / BAR_FULL_SCALE_IV) : 0;

  return (
    <td className="relative overflow-hidden px-2 py-0.5 text-right tabular-nums">
      <div
        className="pointer-events-none absolute inset-y-0 left-0 right-0 origin-right bg-accent-stale"
        style={{
          transform: `scaleX(${barScale})`,
          opacity: isSignificant ? 0.25 : 0,
        }}
        aria-hidden="true"
      />
      <span
        className={`relative inline-block w-[8ch] text-right ${
          isSignificant ? "text-accent-stale" : "text-fg-muted"
        }`}
      >
        {isDefined ? `${miss >= 0 ? "+" : ""}${(miss * 100).toFixed(2)}%` : "—"}
      </span>
    </td>
  );
}

// Memoised — App.tsx hands this 5 Hz-throttled props (`naive`, `gated`
// composites). Without memo, App's compute-cadence re-renders would
// propagate through and re-render all 200 strike rows on every flush.
// With memo + the throttled props, the table only reconciles when the
// underlying slice or fit params actually change, keeping the 5 Hz
// boundary a real render cap at production row counts.
export const OptionChainTable = memo(function OptionChainTable({
  naive,
  gated,
  naiveTruth,
  gatedTruth,
  hoveredK,
  onHoverChange,
}: OptionChainTableProps) {
  const naiveRows = useMemo(() => computeMisses(naive), [naive]);
  const gatedRows = useMemo(() => computeMisses(gated), [gated]);
  const rows: Row[] = useMemo(() => {
    // Pair by index. Both slices share strikes (synthetic feed).
    const reference =
      naiveRows.length >= gatedRows.length ? naiveRows : gatedRows;
    return reference.map((r, i) => ({
      k: r.k,
      naiveMiss: naiveRows[i]?.miss,
      gatedMiss: gatedRows[i]?.miss,
    }));
  }, [naiveRows, gatedRows]);
  const naiveSummary = useMemo(() => summariseMisses(naiveRows), [naiveRows]);
  const gatedSummary = useMemo(() => summariseMisses(gatedRows), [gatedRows]);

  // Ground-truth fit error — fit vs the TRUE surface at each panel's own
  // snapshot. Near-equal across panels and unmoved by the shock; the
  // "this is the fitter, not the tear" baseline beside the coherence number.
  const naiveTruthSummary = useMemo(
    () => summariseMisses(computeTruthMisses(naiveTruth)),
    [naiveTruth],
  );
  const gatedTruthSummary = useMemo(
    () => summariseMisses(computeTruthMisses(gatedTruth)),
    [gatedTruth],
  );

  // Nearest-row index for the hover highlight. Computed once per render
  // rather than per-row inside the map. Returns the row whose `k` is
  // closest to `hoveredK` within `NEAREST_ROW_K_TOLERANCE` — matches the
  // smile overlay's "IV obs" lookup tolerance so the highlighted row
  // visibly tracks the smile cursor at the same threshold.
  const hoveredRowIdx = useMemo(() => {
    if (hoveredK === null) return -1;
    let bestIdx = -1;
    let bestDist = NEAREST_ROW_K_TOLERANCE;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r === undefined) continue;
      const d = Math.abs(r.k - hoveredK);
      if (d <= bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }, [rows, hoveredK]);

  // Mismark ratio for the hero bar — naive's Σ|miss| vs Oracaus's. Used
  // to visualise "how much worse is naive right now". Floored at 1×
  // (Oracaus is the reference); capped at 50× to keep the bar readable
  // when Oracaus drops to LM-noise floor and naive blows up.
  const mismarkRatio =
    naiveSummary !== undefined &&
    gatedSummary !== undefined &&
    gatedSummary.sum > 0
      ? Math.max(1, Math.min(50, naiveSummary.sum / gatedSummary.sum))
      : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-elev contain-[layout_style]">
      {/* HERO — the demo's headline. Big NAIVE vs ORACAUS Σ|miss| numbers
          side-by-side. Mismark-ratio bar below. The "this is what the
          library buys you" frame, in one card. */}
      <div className="shrink-0 border-b border-border px-4 pt-3 pb-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="font-mono text-[10px] uppercase tracking-widest text-fg-muted">
            mismark · Σ|fit − obs|
          </h3>
          <span className="font-mono text-[10px] uppercase tracking-wide text-fg-muted">
            naive ={" "}
            {/* Fixed-width wrapper so digit-count changes ("5.2×" → "12.4×")
                don't shift the trailing "gated". 5ch fits "99.9×"; tabular-
                nums keeps digit widths consistent across font hinting. */}
            <span className="inline-block w-[5ch] text-right tabular-nums text-accent-stale">
              {mismarkRatio === undefined ? "—" : `${mismarkRatio.toFixed(1)}×`}
            </span>{" "}
            oracaus
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <HeroValue
            label="NAIVE"
            tone="stale"
            value={naiveSummary?.sum}
            truth={naiveTruthSummary?.sum}
          />
          <HeroValue
            label="ORACAUS"
            tone="ok"
            value={gatedSummary?.sum}
            truth={gatedTruthSummary?.sum}
          />
        </div>
        {/* Bar container is rendered unconditionally so its height is
            reserved from page load — prevents the "naive = X× gated"
            line + ratio block from shifting vertically when first data
            lands. The fill bar inside scales from 0 (no data → invisible)
            to its target width; transform + opacity are compositor-only. */}
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-bg">
          <div
            className="h-full origin-left bg-accent-stale opacity-70"
            style={{
              transform: `scaleX(${
                mismarkRatio === undefined ? 0 : Math.min(1, mismarkRatio / 20)
              })`,
            }}
            aria-hidden="true"
          />
        </div>
      </div>

      {/* Section label for the per-strike rows. */}
      <header className="flex h-7 shrink-0 items-center border-b border-border px-3">
        <h3 className="font-mono text-[10px] uppercase tracking-widest text-fg-muted">
          per strike
        </h3>
      </header>

      {/* Per-strike rows. Native scroll inside the flex-1 wrapper. The
          parent rail (App.tsx) bounds this height; rows past the
          visible viewport are scrollable via overflow-y-auto.
          `tabIndex={-1}` opts the scroll container out of the tab order —
          Chromium gives scrollable elements implicit `tabindex=0` for
          keyboard scrolling, but the table reads as content not as an
          interactive surface, and the focus rectangle around the whole
          rail breaks the visual register. Mouse-wheel / touch / arrow-key
          scrolling still work; only Tab navigation is suppressed. */}
      <div className="min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
        <table className="w-full table-fixed border-collapse font-mono text-xs">
          <colgroup>
            <col style={{ width: "20%" }} />
            <col style={{ width: "40%" }} />
            <col style={{ width: "40%" }} />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="text-fg-muted">
              <th
                className="border-b border-border bg-bg-elev px-2 py-0.5 text-left font-normal uppercase tracking-wide"
                title="log-moneyness: k = log(K/F)"
              >
                log-money
              </th>
              <th className="border-b border-l border-border bg-bg-elev px-2 py-0.5 text-right font-normal uppercase tracking-wide text-accent-stale">
                naive
              </th>
              <th className="border-b border-l border-border bg-bg-elev px-2 py-0.5 text-right font-normal uppercase tracking-wide text-accent-ok">
                oracaus
              </th>
            </tr>
          </thead>
          {/* Single pointer-leave on tbody clears hover when the cursor
              exits the row stack — cheaper and more reliable than per-row
              leave handlers (those fire and clear when the cursor crosses
              row boundaries, causing flicker on fast scans). */}
          <tbody onPointerLeave={() => onHoverChange(null)}>
            {rows.map((row, i) => {
              const isHovered = i === hoveredRowIdx;
              const baseBg = i % 2 === 0 ? "bg-bg" : "";
              const className = isHovered ? "bg-fg/[0.06]" : baseBg;
              return (
                <tr
                  key={row.k}
                  className={className}
                  onPointerEnter={() => onHoverChange(row.k)}
                >
                  <td className="px-2 py-0.5 text-left tabular-nums text-fg-muted">
                    {row.k.toFixed(2)}
                  </td>
                  <MissCell miss={row.naiveMiss} />
                  <MissCell miss={row.gatedMiss} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
});

// Big number = coherence error (fit vs observed quotes, the divergent
// tear). Small line = ground-truth fit error (fit vs the true surface at
// its own snapshot) — near-equal across panels, the fitter's own residual.
// The contrast is the point: NAIVE's coherence dwarfs its fit error; ORACAUS's
// coherence ≈ its fit error; and the fit error itself matches across both.
function HeroValue({
  label,
  tone,
  value,
  truth,
}: {
  label: string;
  tone: "ok" | "stale";
  value: number | undefined;
  truth: number | undefined;
}) {
  const valueColor = tone === "ok" ? "text-accent-ok" : "text-accent-stale";
  return (
    <div className="flex flex-col">
      <span
        className={`mb-0.5 font-mono text-[10px] uppercase tracking-widest ${valueColor}`}
      >
        {label}
      </span>
      <span
        className={`font-mono text-2xl font-semibold tabular-nums leading-tight ${valueColor}`}
      >
        {value === undefined ? "—" : `${(value * 100).toFixed(2)}%`}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-wide text-fg-muted">
        vs truth{" "}
        <span className="tabular-nums">
          {truth === undefined ? "—" : `${(truth * 100).toFixed(2)}%`}
        </span>
      </span>
    </div>
  );
}
