// MismarkSparkline — bottom-of-rail history panel. Two thin lines on a
// shared y-axis showing the last 60 s of Σ|miss| values (NAIVE in
// stale-red, ORACAUS in ok-green). Fills whatever vertical space the
// per-strike table doesn't claim — on tall viewports it gets a lot of
// room and reads as a proper time-series; on short viewports it
// collapses to a thin strip but stays useful.
//
// History is sampled at 500 ms (2 Hz × 60 s = 120 samples). The SVG
// uses `vector-effect="non-scaling-stroke"` so the polylines stay 1 px
// crisp regardless of the (variable) container width and height —
// saves us a ResizeObserver in this small panel.

import { memo, useEffect, useRef, useState } from "react";

const SAMPLE_INTERVAL_MS = 500;
const WINDOW_SECONDS = 60;
const SAMPLE_COUNT = (WINDOW_SECONDS * 1000) / SAMPLE_INTERVAL_MS; // 120

// Internal viewBox — actual rendering stretches to fill via
// preserveAspectRatio="none". The aspect distortion is fine for a
// sparkline; non-scaling-stroke keeps lines 1 px regardless.
const VIEW_W = 240;
const VIEW_H = 60;

export type MismarkSparklineProps = {
  /** Current Σ|miss| value for the naive panel (in IV-point units). */
  readonly naive: number | undefined;
  /** Current Σ|miss| value for the gated panel (in IV-point units). */
  readonly gated: number | undefined;
};

function MismarkSparklineImpl({ naive, gated }: MismarkSparklineProps) {
  const naiveHistory = useSampledHistory(naive);
  const gatedHistory = useSampledHistory(gated);

  // Shared y-scale — naive's max usually dominates; Oracaus lives down at
  // the LM-noise floor. Auto-scale to whichever is larger so the
  // sparkline always uses its full height.
  const yMax = Math.max(
    1e-3, // floor so the chart doesn't flatten to 0 when both are tiny
    ...naiveHistory.filter(isFiniteNumber),
    ...gatedHistory.filter(isFiniteNumber),
  );

  const naivePath = buildPath(naiveHistory, yMax);
  const gatedPath = buildPath(gatedHistory, yMax);

  return (
    <div className="flex h-40 shrink-0 flex-col border-t border-border bg-bg-elev px-3 py-2 contain-[layout_style]">
      <div className="mb-1.5 flex shrink-0 items-baseline justify-between">
        <h3 className="font-mono text-[10px] uppercase tracking-widest text-fg-muted">
          mismark · last {WINDOW_SECONDS}s
        </h3>
        <div className="flex items-baseline gap-3 font-mono text-[10px] uppercase tracking-widest">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-3 bg-accent-stale"
            />
            <span className="text-fg-muted">naive</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-3 bg-accent-ok"
            />
            <span className="text-fg-muted">oracaus</span>
          </span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="min-h-0 w-full flex-1"
        role="img"
        aria-label="recent Σ|miss| history"
      >
        {/* Faint baseline at y = 0. */}
        <line
          x1={0}
          x2={VIEW_W}
          y1={VIEW_H - 0.5}
          y2={VIEW_H - 0.5}
          stroke="oklch(0.30 0.014 240)"
          strokeWidth={0.5}
          vectorEffect="non-scaling-stroke"
        />
        {/* Paths always render with `d=""` when no history yet, so the
            SVG's DOM structure is stable from first paint. An empty `d`
            renders nothing; switching it to a populated string later
            only updates the attribute, never adds/removes a DOM node. */}
        <path
          d={gatedPath}
          fill="none"
          stroke="oklch(0.72 0.16 145)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          opacity={0.9}
        />
        <path
          d={naivePath}
          fill="none"
          stroke="oklch(0.66 0.20 28)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          opacity={0.9}
        />
      </svg>
    </div>
  );
}

// Memoised — App.tsx hands this 5 Hz-throttled props (naiveMissSum,
// gatedMissSum). Without memo, parent re-renders at compute cadence
// would propagate through and re-render the SVG even when the sampled
// history hasn't ticked. With memo, the sparkline only re-renders when
// its primitive props actually change, plus the internal 2 Hz sampler.
export const MismarkSparkline = memo(MismarkSparklineImpl);

function isFiniteNumber(v: number): v is number {
  return Number.isFinite(v);
}

function buildPath(history: readonly number[], yMax: number): string {
  if (history.length < 2) return "";
  let d = "";
  let started = false;
  for (let i = 0; i < history.length; i++) {
    const v = history[i];
    if (v === undefined || !Number.isFinite(v)) continue;
    const x = (i / (SAMPLE_COUNT - 1)) * VIEW_W;
    const y = VIEW_H - Math.min(1, v / yMax) * VIEW_H;
    d += `${started ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    started = true;
  }
  return d;
}

// Sample the live value at a fixed cadence into a sliding window.
// Buffer lives in a ref; setState happens on every sample so the
// sparkline re-renders at sample rate (2 Hz). NaN entries are written
// when the value is undefined so gaps render as polyline breaks.
function useSampledHistory(currentValue: number | undefined): number[] {
  const [history, setHistory] = useState<number[]>(() =>
    new Array(SAMPLE_COUNT).fill(Number.NaN),
  );
  const valueRef = useRef(currentValue);
  valueRef.current = currentValue;

  useEffect(() => {
    const id = setInterval(() => {
      setHistory((prev) => {
        const next = prev.slice(1);
        const v = valueRef.current;
        next.push(v === undefined || !Number.isFinite(v) ? Number.NaN : v);
        return next;
      });
    }, SAMPLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return history;
}
