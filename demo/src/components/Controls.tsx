// Trader controls — a single horizontal strip that lives in the top
// bar. Three axes:
//   - Tick rate (50 / 100 / 200 / 500 Hz): synthetic feed cadence. Real
//     option-chain refit cadences are 1–20 Hz on most desks; the demo's
//     high range is a proxy for tighter compute-vs-interval ratios.
//   - Surface size (nExpiriesFitted ∈ {12, 30, 50, 70, 80}): the
//     number of expiries the worker fits per tick. Production-typical
//     SPX-class desks fit 30–80; the demo lets viewers walk through the
//     spectrum and see Form 2 manifest at higher counts. (12 is the
//     smallest count at which every display-tenor button maps to a
//     distinct ladder entry; see the EXPIRY_COUNTS declaration for why.)
//   - Vol shock (lightning icon): σ × 5 / OU drift × 5 for 10 s.
//
// Layout register: tight, monospace, no verbose helper text — labels are
// uppercase abbreviations the way a real terminal does. Anything more
// verbose lives in the playbook / README.

import { memo, useEffect, useRef } from "react";
import { trackEvent } from "../analytics.js";
import { LightningIcon, PauseIcon, PlayIcon } from "./icons.js";

// Mirror of `use-feed.ts:SHOCK_BURST_MS`. Kept in sync by convention —
// the visual depletion runs for exactly the duration the feed treats as
// "shocking", so the button re-enables the instant the fill empties.
const SHOCK_BURST_MS = 10_000;

export type ControlsProps = {
  readonly tickRateHz: number;
  readonly setTickRateHz: (value: number) => void;
  readonly nExpiriesFitted: number;
  readonly setNExpiriesFitted: (value: number) => void;
  readonly displayMaturityYears: number;
  readonly setDisplayMaturityYears: (value: number) => void;
  readonly repairMode: "on" | "off";
  readonly setRepairMode: (value: "on" | "off") => void;
  readonly onShock: () => void;
  readonly shocking: boolean;
  /**
   * Optional handler for the commentary play/pause toggle button. When
   * supplied (along with `commentaryEnabled`), the toolbar renders the
   * labelled COMMENTARY group trailing the shock group. Clicking the
   * button flips `commentaryEnabled` (the parent owns the state). Omit
   * BOTH props to hide the toggle entirely — used in recording mode
   * where the canonical take must not be perturbable mid-flight.
   */
  readonly onCommentaryToggleClick?: () => void;
  /**
   * Current commentary on/off state. When `true` the pause icon renders
   * (click to pause) + `aria-pressed` is `true`; when `false` the play
   * icon renders. Must be supplied iff `onCommentaryToggleClick` is.
   */
  readonly commentaryEnabled?: boolean;
};

const TICK_RATES = [50, 100, 200, 500] as const;
// 6 was deliberately dropped — at six exponentially-spaced points across
// [1w, 3y] the inter-step ratio (~2.75) is wider than the 1Y→2Y target
// gap, so `1Y` and `2Y` both collapse onto the same ladder entry
// (T≈1.085) and clicking between them is a visual no-op. 12 is the
// smallest count where all five display tenors land on distinct ladder
// entries; higher counts step the failure-mode-escalation axis.
const EXPIRY_COUNTS = [12, 30, 50, 70, 80] as const;
const REPAIR_MODES = ["on", "off"] as const;

// Display-maturity selection presents desk-standard tenors. The
// underlying ladder (built by `buildExpiryLadder` in feed.ts) is
// exponentially spaced from 1 week to 3 years; the panel projects
// whichever maturity is closest to the selected tenor.
//
// Exported because App.tsx derives the panel-title expiry label from
// `displayMaturityYears` and needs the same `(years → label)` mapping
// the buttons here render. Single source of truth for desk-standard
// tenor names across the demo.
export const DISPLAY_MATURITIES: ReadonlyArray<{
  years: number;
  label: string;
}> = [
  { years: 0.083, label: "1M" },
  { years: 0.25, label: "3M" },
  { years: 0.5, label: "6M" },
  { years: 1.0, label: "1Y" },
  { years: 2.0, label: "2Y" },
];

// Per-tick compute (p99 warm at 200 strikes per slice on M-series Mac,
// measured via `npm run bench`). Surfaced in the tooltip so the viewer
// can predict where they sit relative to the [50, 150] ms Form 2 zone
// without consulting the docs. Shifts with hardware and the fit pipeline;
// re-measure after any change.
const ESTIMATED_COMPUTE_MS: Record<number, number> = {
  12: 15,
  30: 36,
  50: 58,
  70: 82,
  80: 92,
};

// Memoised. App.tsx re-renders at the feed tick rate (50–500 Hz on the
// selectable range), but `Controls`'s props are mostly stable across
// those renders — only `shocking` flips during a shock burst, and
// `tickRateHz` / `nExpiriesFitted` / etc. change only on user
// interaction. Without memo, the entire toolbar (multiple button
// groups + the shock icon) reconciles at App's full cadence,
// competing with hover and scroll work. With memo + stable
// callbacks (`triggerShock` is `useCallback`'d in `use-feed.ts`,
// useState setters are stable by spec), Controls renders only when
// something it cares about actually changes.
function ControlsImpl(props: ControlsProps) {
  // Time-remaining indicator for the shock burst. An absolutely-positioned
  // amber span inside the button is scaled from full to empty (transform:
  // scaleY(1) → scaleY(0)) over 10 s on the compositor, anchored at the
  // bottom edge — the amber starts covering the button and "drains
  // downward" as the burst progresses, like sand through the hourglass
  // neck. The empty region grows from the top down; at t=10s the amber
  // has fully drained and the button re-enables. No React re-renders, no
  // main-thread paint per frame. Mirrors the WAAPI idiom used by
  // `Smile.tsx`'s y-axis transition. Reduced-motion adopters get duration
  // 0 — the static disabled state carries the "wait" affordance on its
  // own.
  const depleteRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!props.shocking) return;
    const el = depleteRef.current;
    if (el === null) return;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const animation = el.animate(
      [{ transform: "scaleY(1)" }, { transform: "scaleY(0)" }],
      {
        duration: prefersReducedMotion ? 0 : SHOCK_BURST_MS,
        easing: "linear",
        fill: "forwards",
      },
    );
    return (): void => {
      animation.cancel();
    };
  }, [props.shocking]);

  return (
    <div className="flex items-center gap-4 font-mono text-xs">
      {/* Tick rate. */}
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wide text-fg-muted">tick</span>
        <div className="flex gap-1">
          {TICK_RATES.map((rate) => (
            <button
              key={rate}
              type="button"
              onClick={() => {
                if (rate === props.tickRateHz) return;
                trackEvent("tick-rate-changed", { rate });
                props.setTickRateHz(rate);
              }}
              className={`focus-ring rounded border px-2 py-0.5 ${
                props.tickRateHz === rate
                  ? "border-accent-info bg-bg text-accent-info"
                  : "border-border bg-bg text-fg-muted hover:text-fg"
              }`}
              aria-pressed={props.tickRateHz === rate}
              title={`drive the synthetic feed at ${rate} ticks per second`}
            >
              {rate}
            </button>
          ))}
        </div>
      </div>

      {/* Surface size. Stepped selector since the option set is discrete.
          Tooltip shows the estimated per-tick compute for each step so the
          viewer can predict the Form 2 zone position without consulting
          the bench documentation. */}
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wide text-fg-muted">expiries</span>
        <div className="flex gap-1">
          {EXPIRY_COUNTS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => {
                if (n === props.nExpiriesFitted) return;
                trackEvent("expiry-changed", { count: n });
                props.setNExpiriesFitted(n);
              }}
              className={`focus-ring rounded border px-2 py-0.5 tabular-nums ${
                props.nExpiriesFitted === n
                  ? "border-accent-info bg-bg text-accent-info"
                  : "border-border bg-bg text-fg-muted hover:text-fg"
              }`}
              aria-pressed={props.nExpiriesFitted === n}
              title={`~${ESTIMATED_COMPUTE_MS[n] ?? "?"} ms p99 compute`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Repair mode — calendar-arb repair pass on/off. Wired as the
          substrate's `intent` input (not `streaming`): toggling cancels
          any in-flight compute on the gated panel and restarts against
          the new mode. NAIVE has no cancel semantics — in-flight
          completes against whichever mode was current at post time,
          producing a brief lag between toggle and visible mode change.
          That contrast is the live demonstration of cancel-and-restart
          (gated) vs absorb (naive). */}
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wide text-fg-muted">repair</span>
        <div className="flex gap-1">
          {REPAIR_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                if (mode === props.repairMode) return;
                trackEvent("repair-toggled", { mode });
                props.setRepairMode(mode);
              }}
              className={`focus-ring rounded border px-2 py-0.5 ${
                props.repairMode === mode
                  ? "border-accent-info bg-bg text-accent-info"
                  : "border-border bg-bg text-fg-muted hover:text-fg"
              }`}
              aria-pressed={props.repairMode === mode}
              title={
                mode === "on"
                  ? "calendar-arb repair pass enabled (production-realistic)"
                  : "skip calendar-arb repair — emit per-slice fits as-is"
              }
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Display maturity — which slice both panels render. Shared
          state so the NAIVE-vs-ORACAUS comparison is on the same tenor.
          The panel projects to whichever ladder index is closest to
          the selected years. */}
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wide text-fg-muted">slice</span>
        <div className="flex gap-1">
          {DISPLAY_MATURITIES.map(({ years, label }) => (
            <button
              key={years}
              type="button"
              onClick={() => {
                if (Math.abs(props.displayMaturityYears - years) < 1e-6) return;
                trackEvent("maturity-changed", { tenor: label });
                props.setDisplayMaturityYears(years);
              }}
              className={`focus-ring rounded border px-2 py-0.5 tabular-nums ${
                Math.abs(props.displayMaturityYears - years) < 1e-6
                  ? "border-accent-info bg-bg text-accent-info"
                  : "border-border bg-bg text-fg-muted hover:text-fg"
              }`}
              aria-pressed={Math.abs(props.displayMaturityYears - years) < 1e-6}
              title={`display the ${label} slice on both panels`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Vol shock — lightning icon. While shocking, the icon stays
          highlighted in accent-warn (amber) and an inner amber fill
          depletes from full to empty over 10 s (compositor-only scaleY
          animation on a positioned span) as a visible "time remaining"
          indicator. Amber reads as "caution / alert" rather than
          "failure" — the shock is an intentional regime change, not a
          panel error. */}
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wide text-fg-muted">shock</span>
        <button
          type="button"
          onClick={() => {
            trackEvent("shock-triggered");
            props.onShock();
          }}
          disabled={props.shocking}
          title={
            props.shocking ? "vol shock active (10s)" : "trigger vol shock"
          }
          aria-label="trigger volatility shock"
          className={`focus-ring focus-visible:outline-accent-warn relative flex h-9 w-9 items-center justify-center overflow-hidden rounded border ${
            props.shocking
              ? "cursor-not-allowed border-accent-warn text-accent-warn"
              : "border-accent-warn/60 bg-accent-warn/4 text-accent-warn hover:border-accent-warn hover:bg-accent-warn/8"
          }`}
        >
          {/* Draining time-remaining fill. Painted behind the icon via
              document order — the icon's wrapping span carries `relative`
              to land on top of the absolutely-positioned amber.
              `origin-bottom` anchors the amber to the bottom edge so as
              `scaleY` decreases the top edge sinks downward (amber drains
              toward the bottom), rather than the bottom edge rising. */}
          {props.shocking && (
            <span
              ref={depleteRef}
              aria-hidden="true"
              className="absolute inset-0 origin-bottom bg-accent-warn/25"
            />
          )}
          <span className="relative">
            <LightningIcon />
          </span>
        </button>
      </div>

      {/* Commentary play/pause toggle — labelled COMMENTARY group plus a
          single button. Optional; renders only when the parent provides
          both `onCommentaryToggleClick` and `commentaryEnabled`. Recording
          mode omits both props so the cluster is hidden (canonical take
          must not be perturbable mid-flight). Media-player convention:
          while running the icon is PAUSE (click to pause); while paused
          the icon is PLAY (click to play). `aria-label` and `title` track
          the NEXT action; `aria-pressed` reflects the current toggle
          state (true = running). */}
      {props.onCommentaryToggleClick !== undefined &&
        props.commentaryEnabled !== undefined && (
          <div className="flex items-center gap-2">
            <span className="uppercase tracking-wide text-fg-muted">
              commentary
            </span>
            <button
              type="button"
              onClick={props.onCommentaryToggleClick}
              title={
                props.commentaryEnabled ? "pause commentary" : "play commentary"
              }
              aria-label={
                props.commentaryEnabled ? "pause commentary" : "play commentary"
              }
              aria-pressed={props.commentaryEnabled}
              data-testid="toolbar-commentary-toggle"
              className={`focus-ring flex h-7 w-7 items-center justify-center rounded border ${
                props.commentaryEnabled
                  ? "border-accent-info bg-accent-info/10 text-accent-info hover:bg-accent-info/20"
                  : "border-border bg-bg text-fg-muted hover:border-accent-info hover:text-accent-info"
              }`}
            >
              {props.commentaryEnabled ? <PauseIcon /> : <PlayIcon />}
            </button>
          </div>
        )}
    </div>
  );
}

export const Controls = memo(ControlsImpl);
