// Demo panel — one (dots, curve) pair plus a verification UI that
// distinguishes WHAT THE LIBRARY FIXES from WHAT IT DOESN'T.
//
// Vertical-rail layout: panel fills its parent's height (parent applies
// flex-1 / min-h-0). Inside, three rows:
//   - header (~36 px): title + subtitle + FITTING/COHERENT badges
//   - chart (flex-1): fills remaining space — Smile is rendered at the
//     measured pixel size of its container
//   - stats strip (~36 px): single horizontal row of metric pairs
//     `label: value · label: value · …`, panel-coloured (NAIVE = stale-
//     red accent, ORACAUS = ok-green accent), terse desk-style labels.
//
// Three metrics:
//   - snapshot lag: `current_tick − panel_snapshot_tick` (library FIXES)
//   - stale-fit error: `mean_k |w(k, fit_params) − w(k, panel_truth)|`
//     (library FIXES — the visceral tearing measure)
//   - fit residual: `mean_k |w(k, fit_params) − w_obs(k)|` (LM noise,
//     intrinsic, library doesn't fix this — surfaced for honesty)
//
// Memoised at the export (`memo(PanelImpl)`). The 5 Hz display throttle
// in App.tsx hands the panel reference-stable props on a 200 ms
// boundary; without `memo` here, App's compute-cadence re-renders would
// propagate through anyway and the throttle would be cosmetic. With
// `memo`, the panel re-renders at most every 200 ms. Required for the
// chart's SVG path updates to stay off the hot path.

import { memo, useEffect, useMemo, useState } from "react";
import { useElementSize } from "../hooks/use-element-size.js";
import type { FitSnapshot } from "../hooks/use-naive-fit.js";
import { computeSnapshotLag } from "../metrics.js";
import type { SurfaceArbStatus } from "../svi/no-arb.js";
import type { SviParams } from "../svi/params.js";
import { w } from "../svi/svi.js";
import type { DemoComputeOutput } from "../types.js";
import { Smile } from "./Smile.js";

const STALE_DOT_THRESHOLD = 0.003;
const STALE_ENTER_THRESHOLD = 0.005;
const COHERENT_RETURN_THRESHOLD = 0.0015;
const IDLE_DEBOUNCE_MS = 150;
const FLASH_RESTART_MS = 600;

// Lag-tone hysteresis. Drives the lag METRIC NUMBER's red/green tone
// (NOT the COHERENT/STALE header chip — that's mismark-driven for
// both modes; see `headerCoherent` below). Calibrated so:
//
//   - Scenario 0 envelope (lag 1–9 ticks from the 5 Hz throttle on
//     `feed.tick` while data is set eagerly) stays inside the green
//     band; the lag NUMBER reads green, the chip says COHERENT
//     because mismark is at noise floor, and the chart looks clean.
//
//   - Scenario 1+ envelope (lag 40+ ticks from queue saturation)
//     trips the red tone clearly above the noise floor.
//
//   - Hysteresis range 3..10 is wider than the Scenario 0 envelope so
//     the lag NUMBER doesn't flicker tone every 200 ms display flush.
//
// Pre-Phase-1 these were 2/1 — calibrated for Oracaus's natural
// 1–3 tick variation under the OLD (clamping) lag formula. With the
// honest formula the naive number spans 1–9 at Scenario 0; the old
// thresholds caused 1 Hz tone-flicker. See DEMO_METRIC_FIX_PLAN.md.
const LAG_STALE_ENTER_TICKS = 10;
const LAG_OK_RETURN_TICKS = 3;

export type PanelProps = {
  readonly title: string;
  readonly subtitle?: string;
  readonly data: DemoComputeOutput | undefined;
  readonly latestInputs: FitSnapshot | undefined;
  readonly isComputing: boolean;
  readonly mode: "naive" | "gated";
  readonly currentTickIndex: number | undefined;
  readonly pendingCount?: number;
  /**
   * Monotonic counter that increments every time the user changes an
   * intent input (Oracaus panel only — naive doesn't use intent). A
   * change triggers a brief "restart" flash on the fitting chip,
   * because `isComputing` stays continuously true across the
   * substrate's cancel-and-restart and provides no natural transition
   * the user could otherwise see.
   */
  readonly intentChangedKey?: number;
  /**
   * Cross-view hover state — k-coordinate currently hovered in either
   * smile or the option chain row. App-owned; both panels and the table
   * share the same value so a hover anywhere lights up everywhere.
   * `null` = no hover.
   */
  readonly hoveredK: number | null;
  /** Setter for the cross-view hover state. Forwarded to `Smile`. */
  readonly onHoverChange: (k: number | null) => void;
  /**
   * Smile chart axis ranges. Owned by `App.tsx` (Y adapts to the
   * displayed maturity, so it cannot live as a module constant here);
   * passed in pre-memoised so `Smile`'s shallow-compare memo still sees
   * stable references frame-to-frame.
   */
  readonly smileXRange: readonly [number, number];
  readonly smileYRange: readonly [number, number];
};

function PanelImpl(props: PanelProps) {
  const { data, latestInputs, isComputing, mode, currentTickIndex } = props;
  const [chartRef, chartSize] = useElementSize<HTMLDivElement>();

  const dotsSlice = mode === "naive" ? latestInputs?.slice : data?.sourceSlice;
  const dotsTrueParams =
    mode === "naive" ? latestInputs?.trueParams : data?.sourceTrueParams;
  const fitParams =
    data?.fitResult.ok === true ? data.fitResult.params : undefined;
  const arbStatus = data?.surfaceArbStatus;

  const staleFitError = computeStaleFitError(fitParams, dotsTrueParams);

  // Memoised — the mapped array is the `tornStrikes` prop on the
  // memoised Smile; without useMemo this would be a fresh array every
  // panel render and break Smile's memo equality.
  const tornStrikes = useMemo(
    () =>
      mode === "naive" &&
      fitParams !== undefined &&
      dotsTrueParams !== undefined
        ? (dotsSlice?.quotes ?? []).map((q) => {
            const wFit = w(q.logMoneyness, fitParams);
            const wTruth = w(q.logMoneyness, dotsTrueParams);
            return Math.abs(wFit - wTruth) > STALE_DOT_THRESHOLD;
          })
        : undefined,
    [mode, fitParams, dotsTrueParams, dotsSlice],
  );

  // Memoised — Smile takes `{ k, iv }[]`; the mapping creates a new
  // array, which would break Smile's memo equality on every panel
  // render. The mapping is cheap (one pass over quotes) but only
  // worth doing when the source slice actually changed.
  const smileQuotes = useMemo(
    () =>
      dotsSlice?.quotes.map((q) => ({
        k: q.logMoneyness,
        iv: q.impliedVol,
      })) ?? [],
    [dotsSlice],
  );

  // Lag formula lives in `../metrics.ts` — see that file for the per-
  // mode rationale (naive: abs structural gap; gated: max-0 staleness).
  const snapshotLag = computeSnapshotLag(mode, {
    latestInputsTickIndex: latestInputs?.tickIndex,
    dataSourceTickIndex: data?.sourceTickIndex,
    currentTickIndex,
  });

  // `stickyCoherent` tracks visual-mismark hysteresis. Drives the
  // mismark metric's tone AND the header chip on both modes. The chip
  // annotates the visible failure (dots-vs-curve disagreement above
  // noise floor) directly. On ORACAUS, mismark equals the LM residual
  // against the commit's own snapshot — always near zero in normal
  // operation, so the chip surfaces fitter-health regressions if the
  // worker ever returns garbage. On NAIVE, mismark reflects the
  // cross-tick drift between latestInputs.trueParams and fitParams;
  // visible tearing fires the chip via mismark > 0.005.
  const [stickyCoherent, setStickyCoherent] = useState(true);
  useEffect(() => {
    if (staleFitError === undefined) return;
    if (staleFitError > STALE_ENTER_THRESHOLD) setStickyCoherent(false);
    else if (staleFitError < COHERENT_RETURN_THRESHOLD) setStickyCoherent(true);
  }, [staleFitError]);

  // `stickyLagStale` tracks structural-lag hysteresis. Drives the lag
  // metric's tone and (on NAIVE) the header chip.
  const [stickyLagStale, setStickyLagStale] = useState(false);
  useEffect(() => {
    if (snapshotLag === undefined) return;
    if (snapshotLag > LAG_STALE_ENTER_TICKS) setStickyLagStale(true);
    else if (snapshotLag <= LAG_OK_RETURN_TICKS) setStickyLagStale(false);
  }, [snapshotLag]);

  // Header chip semantics — mismark-driven for both modes. The chip
  // annotates "is the chart visibly torn right now" — i.e. does the
  // displayed (dots, curve) pair disagree at LM-residual-or-larger
  // scale? `stickyCoherent` reflects exactly that (mismark > 0.005
  // enters STALE; <= 0.0015 returns COHERENT).
  //
  // NAIVE specifically also has a STRUCTURAL lag (between the
  // displayed input view and the displayed fit) — surfaced via the
  // lag metric NUMBER (with its own red/green tone via
  // `stickyLagStale`). That is the right place for structural
  // information; the chip remains tied to the visible failure mode.
  //
  // Pre-Phase-1 the chip OR-combined lag and mismark on NAIVE, but
  // that was downstream of a lag formula that lied (clamped to 0).
  // With the honest formula the lag fluctuates 1–9 at Scenario 0
  // from the 5 Hz throttle staleness — fine for a structural number
  // but it would make the chip flicker. Decoupling chip (visible
  // tear) from lag (structural number) aligns each signal with what
  // a trader expects to see. See DEMO_METRIC_FIX_PLAN.md.
  const headerCoherent = stickyCoherent;

  const [stickyComputing, setStickyComputing] = useState(isComputing);
  useEffect(() => {
    if (isComputing) {
      setStickyComputing(true);
      return;
    }
    const id = setTimeout(() => setStickyComputing(false), IDLE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [isComputing]);

  // Brief restart-flash on the fitting chip when intent changes. The
  // initial mount also runs this effect, but `intentChangedKey` starts
  // at 0 from App — we treat 0 as "no flash yet" and only fire when it
  // increments. Cleared after FLASH_RESTART_MS.
  const { intentChangedKey } = props;
  const [restartFlashing, setRestartFlashing] = useState(false);
  useEffect(() => {
    if (intentChangedKey === undefined || intentChangedKey === 0) return;
    setRestartFlashing(true);
    const id = setTimeout(() => setRestartFlashing(false), FLASH_RESTART_MS);
    return () => clearTimeout(id);
  }, [intentChangedKey]);

  // App-level 5 Hz throttle gates every prop entering the panel; the
  // formerly-internal stats throttle (and its setInterval) was removed
  // because it would be a redundant second 5 Hz layer on already-5 Hz
  // inputs. `staleFitError` etc. recompute at most once per panel
  // render (= 5 Hz under normal operation).
  const accentClass = mode === "naive" ? "text-accent-stale" : "text-accent-ok";
  const tintClass =
    mode === "naive" ? "bg-accent-stale/[0.06]" : "bg-accent-ok/[0.06]";

  return (
    <article className="flex h-full flex-col bg-bg-elev">
      {/* Header — 32 px, mode-tinted background so panel identity reads
          pre-attentively. Title only (subtitle dropped — chatty for the
          desk register); filled status chips on the right. */}
      <header
        className={`flex h-8 shrink-0 items-center justify-between border-b border-border px-3 ${tintClass}`}
      >
        <h3
          className={`font-mono text-sm font-semibold uppercase tracking-widest ${accentClass}`}
        >
          {props.title}
          {props.subtitle !== undefined && (
            <span className="ml-3 font-normal text-fg-muted">
              {props.subtitle}
            </span>
          )}
        </h3>
        <div className="flex shrink-0 items-center gap-2">
          <span
            // No transition-colors: this chip flips state at the
            // commit cadence (~5 Hz). A 150 ms colour fade would leave
            // it in a transitioning blur most of the time. The crisp
            // flip reads like a trading-terminal status indicator
            // — Bloomberg, not consumer app.
            className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest ${
              restartFlashing
                ? "bg-accent-warn text-bg"
                : stickyComputing
                  ? "bg-accent-info text-bg"
                  : "text-fg-muted opacity-50"
            }`}
            aria-live="polite"
          >
            <span className="inline-block w-[8ch] text-center">
              {restartFlashing
                ? "restart"
                : stickyComputing
                  ? "fitting"
                  : "idle"}
            </span>
          </span>
          <span
            className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest ${
              headerCoherent
                ? "bg-accent-ok text-bg"
                : "bg-accent-stale text-bg"
            }`}
            aria-live="polite"
          >
            <span className="inline-block w-[9ch] text-center">
              {headerCoherent ? "coherent" : "stale"}
            </span>
          </span>
          <ArbStatusChip status={arbStatus} />
        </div>
      </header>

      {/* Chart — fills remaining height. Container is measured via
          ResizeObserver; Smile renders at the resolved pixel size. */}
      <div className="min-h-0 flex-1 p-2 contain-[layout_style]">
        <div ref={chartRef} className="h-full w-full">
          {chartSize.width > 0 && chartSize.height > 0 && (
            <Smile
              quotes={smileQuotes}
              fittedParams={fitParams}
              timeToExpiry={dotsSlice?.timeToExpiry ?? 1}
              width={chartSize.width}
              height={chartSize.height}
              xRange={props.smileXRange}
              yRange={props.smileYRange}
              hoveredK={props.hoveredK}
              onHoverChange={props.onHoverChange}
              cursorTone={mode === "naive" ? "stale" : "ok"}
              {...(tornStrikes !== undefined ? { tornStrikes } : {})}
            />
          )}
        </div>
      </div>

      {/* Metric ribbon — 28 px, compact. Failure-mode indicators inline.
          All values recompute at the panel's 5 Hz render cadence (set
          by the App-level throttle on data + latestInputs). */}
      <div className="flex h-7 shrink-0 items-center gap-6 border-t border-border px-3 font-mono contain-[layout_style]">
        <Metric
          label="lag"
          value={snapshotLag === undefined ? "—" : `${snapshotLag}t`}
          tone={
            snapshotLag === undefined
              ? "muted"
              : stickyLagStale
                ? "stale"
                : "ok"
          }
          width="7ch"
        />
        <Metric
          label="compute"
          value={
            data?.computeMs === undefined
              ? "—"
              : `${data.computeMs.toFixed(0)}ms`
          }
          // Tone-coded against the documented Form 2 zone [50, 150] ms
          // (CLAUDE.md §Locked nomenclature → The boundary heuristic):
          //   < 50 ms : pre-Form-2  — muted (failure not visible)
          //   50–150  : in-zone     — ok    (tearing demonstrable)
          //   > 150   : over-zone   — stale (display throttle starts to mask)
          tone={
            data?.computeMs === undefined
              ? "muted"
              : data.computeMs > 150
                ? "stale"
                : data.computeMs >= 50
                  ? "ok"
                  : "muted"
          }
          width="7ch"
        />
        <Metric
          label="mismark"
          value={
            staleFitError === undefined ? "—" : staleFitError.toExponential(1)
          }
          tone={stickyCoherent ? "ok" : "stale"}
          width="8ch"
        />
        <Metric
          label="queue"
          value={mode === "naive" ? `${props.pendingCount ?? 0}` : "0"}
          tone={
            mode === "naive" && (props.pendingCount ?? 0) > 1
              ? "stale"
              : "muted"
          }
          width="6ch"
        />
      </div>
    </article>
  );
}

// `Panel` is memoised — App.tsx hands it 5 Hz-throttled, reference-
// stable props; without memo here the App's compute-cadence re-renders
// would propagate through anyway and re-render the SVG / metric ribbon
// at 13 Hz, defeating the throttle. With memo, panel re-renders are
// bounded by the throttle.
export const Panel = memo(PanelImpl);

/**
 * Surface-level calendar-arb status. Four possible values:
 *   - `arb-free`        — checked, no violations
 *   - `repair-applied`  — violations repaired; output is arb-free (blue)
 *   - `repair-failed`   — repair attempted, residual violations (red)
 *   - `arb-violation`   — checked, violations found, no repair attempted
 *                         (`repairMode = "off"`; amber — user-elected, not a
 *                         failure)
 *
 * `undefined` is the "no data yet" state. Rendered next to FITTING/COHERENT
 * so a viewer scanning the chip row sees the surface-level failure mode
 * alongside the per-panel ones.
 */
function ArbStatusChip({ status }: { status: SurfaceArbStatus | undefined }) {
  let label: string;
  let className: string;
  switch (status) {
    case "arb-free":
      label = "arb-free";
      className =
        "rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-fg-muted opacity-60";
      break;
    case "repair-applied":
      label = "repaired";
      className =
        "rounded bg-accent-info px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-bg";
      break;
    case "repair-failed":
      label = "arb-viol";
      className =
        "rounded bg-accent-stale px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-bg";
      break;
    case "arb-violation":
      label = "arb-viol";
      className =
        "rounded bg-accent-warn px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-bg";
      break;
    default:
      label = "—";
      className =
        "rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-fg-muted opacity-30";
      break;
  }
  return (
    <span className={className} aria-live="polite">
      <span className="inline-block w-[10ch] text-center text-nowrap">
        {label}
      </span>
    </span>
  );
}

function Metric({
  label,
  value,
  tone,
  width,
}: {
  label: string;
  value: string;
  tone: "ok" | "stale" | "muted";
  width: string;
}) {
  const valueClass =
    tone === "ok"
      ? "text-accent-ok"
      : tone === "stale"
        ? "text-accent-stale"
        : "text-fg-muted";
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <span className="text-[9px] uppercase tracking-widest text-fg-muted">
        {label}
      </span>
      <span
        className={`inline-block text-right text-xs font-semibold tabular-nums ${valueClass}`}
        style={{ width }}
      >
        {value}
      </span>
    </span>
  );
}

function computeStaleFitError(
  fit: SviParams | undefined,
  truth: SviParams | undefined,
): number | undefined {
  if (fit === undefined || truth === undefined) return undefined;
  let sum = 0;
  const N = 21;
  for (let i = 0; i < N; i++) {
    const k = -1 + (2 * i) / (N - 1);
    sum += Math.abs(w(k, fit) - w(k, truth));
  }
  return sum / N;
}
