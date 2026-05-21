// Hand-rolled SVG smile plot. No charting library.
//
// Why hand-rolled: the financial register is too specific for library
// defaults to nail (we'd override most things); the bundle weight
// (25–700 KB gz of any charting library) dominates the demo budget
// without solving any problem we have; React reconciliation over ~200
// SVG nodes per panel is essentially free at our update cadence; and
// keeping the rendering explicit makes the demo a teaching artefact —
// readers can trace data flow without learning a charting library's API.
//
// Layout: x = log-moneyness; y = implied vol (decimal). Observed quotes
// render as dots; the fitted SVI surface samples 100 points along the
// curve and joins them as a single `<path>`. Calibration-range shading
// (low-opacity rect) marks where the fit is reliable; outside this range
// SVI extrapolates and can produce arbitrage-violating IVs.
//
// The SVG `<g transform>` wrapper keeps tick / curve updates compositor-
// cheap (no layout invalidation on data change). Tick math via `d3-scale`
// (`linear().nice().ticks(N)`).

import { scaleLinear } from "d3-scale";
import {
  memo,
  type PointerEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { gatheralG } from "../svi/diagnostics.js";
import type { SviParams } from "../svi/params.js";
import { varianceToIv, w } from "../svi/svi.js";

export type SmileQuote = {
  readonly k: number; // log-moneyness
  readonly iv: number; // implied vol (decimal)
};

// Maximum k-distance from `hoveredK` at which a quote is still considered
// "nearest" for the overlay's IV obs / miss readout. At the demo's
// 200-strikes-over-[-1,1] geometry the inter-strike step is ≈0.01 in k;
// ±0.02 covers two strike widths — outside that we display "—" rather
// than label a distant quote as the hovered point.
const NEAREST_QUOTE_K_TOLERANCE = 0.02;

// Cross-view cursor stroke colour. Mirrors the panel accent palette
// (`styles.css` — `--color-accent-stale` red for NAIVE, `--color-accent-ok`
// green for GATED) so the cursor line reinforces panel identity at a
// glance — red on the torn panel, green on the coherent one. The
// constants are inlined to keep the SVG attribute path free of CSS-var
// lookups (the stroke is set per-render).
const CURSOR_STROKE_STALE = "oklch(0.66 0.20 28)";
const CURSOR_STROKE_OK = "oklch(0.72 0.16 145)";

export type SmileProps = {
  readonly quotes: readonly SmileQuote[];
  readonly fittedParams: SviParams | undefined;
  readonly timeToExpiry: number;
  readonly width: number;
  readonly height: number;
  readonly xRange: readonly [number, number];
  readonly yRange: readonly [number, number];
  readonly tornStrikes?: readonly boolean[]; // per-quote red flag for in-panel coherence error
  /**
   * Controlled hover state — k-coordinate currently under the cross-view
   * hover (Smile pointer-move or OptionChainTable row hover). `null` means
   * no hover. Owned by `App.tsx` so all three views (NAIVE smile, GATED
   * smile, option chain) reflect the same hovered k.
   */
  readonly hoveredK: number | null;
  /**
   * Setter for the controlled hover state. Smile invokes this on its own
   * pointer-move (converting cursor x to k via the inverse x-scale) and
   * pointer-leave (clears to `null`).
   */
  readonly onHoverChange: (k: number | null) => void;
  /**
   * Cursor-line accent tone. `"stale"` paints the dashed cursor in the
   * NAIVE-panel red; `"ok"` paints it in the GATED-panel green. Same
   * line, same dashing, same opacity — only the stroke colour changes,
   * so a glance at the cursor immediately says which panel it's on.
   */
  readonly cursorTone: "stale" | "ok";
};

// Margins reserve room for axis tick labels only — the verbose x-axis
// subtitle was dropped (the log-moneyness axis is shown by its tick
// values; readers familiar with vol surfaces don't need a caption, and
// readers who aren't won't be fluent in `log(K/F)` anyway).
//
// `right: 16` is set wide enough to fit half the rightmost x-tick label
// (e.g. "1.00") past the tick position, since `text-anchor="middle"`
// centers the label on the tick. The previous `10` clipped the last
// digit at the viewBox edge.
const MARGIN = { top: 8, right: 16, bottom: 22, left: 36 };
const FIT_SAMPLES = 100;

function SmileImpl(props: SmileProps) {
  const { quotes, fittedParams, timeToExpiry, width, height } = props;
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;

  // Scales depend only on geometry + axis ranges, not on tick data.
  // Memoise so the entire `<StaticAxes>` subtree below can also stay
  // stable (its props are derived from these). At the 5 Hz tick flush
  // this skips reconciliation of ~30 axis nodes per chart.
  const xRange0 = props.xRange[0];
  const xRange1 = props.xRange[1];
  const yRange0 = props.yRange[0];
  const yRange1 = props.yRange[1];
  const x = useMemo(
    () => scaleLinear().domain([xRange0, xRange1]).range([0, innerW]).nice(6),
    [xRange0, xRange1, innerW],
  );
  const y = useMemo(
    () => scaleLinear().domain([yRange0, yRange1]).range([innerH, 0]).nice(5),
    [yRange0, yRange1, innerH],
  );
  const xTicks = useMemo(() => x.ticks(6), [x]);
  const yTicks = useMemo(() => y.ticks(5), [y]);

  // Memoise the fit path string — buildCurvePath samples 100 points and
  // builds an SVG path-data string. The path attribute update triggers
  // SVG layout work, so skipping the work when params haven't changed
  // is load-bearing for the 5 Hz throttle's perf benefit.
  const fittedPath = useMemo(
    () =>
      fittedParams
        ? buildCurvePath(fittedParams, x, y, timeToExpiry, props.xRange)
        : "",
    [fittedParams, x, y, timeToExpiry, props.xRange],
  );
  // Pointer handlers — translate cursor x to a k value via the inverse
  // x-scale, clamped to `xRange`. Out-of-domain pointer positions emit
  // `null` so the cross-view cursor and overlay disappear at the chart
  // edges (rather than pinning to an extrapolated k). Pointer-leave on
  // the SVG also clears hover.
  const { onHoverChange } = props;
  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const localX = event.clientX - rect.left - MARGIN.left;
      if (localX < 0 || localX > innerW) {
        onHoverChange(null);
        return;
      }
      const k = x.invert(localX);
      if (k < xRange0 || k > xRange1) {
        onHoverChange(null);
        return;
      }
      onHoverChange(k);
    },
    [innerW, x, xRange0, xRange1, onHoverChange],
  );
  const handlePointerLeave = useCallback(() => {
    onHoverChange(null);
  }, [onHoverChange]);

  // Overlay content — derived at render time from (hoveredK, params,
  // quotes, T). All five lines come from the same logical snapshot as
  // the panel's dots and curve (Panel selects `quotes` per mode — NAIVE
  // reads `latestInputs.slice`, GATED reads `data.sourceSlice` — so the
  // overlay's "IV obs" composes correctly with whichever slice the panel
  // is rendering).
  const overlay = useMemo(
    () =>
      props.hoveredK === null
        ? null
        : computeOverlay(props.hoveredK, fittedParams, quotes, timeToExpiry),
    [props.hoveredK, fittedParams, quotes, timeToExpiry],
  );

  // Unique clipPath id per Smile instance — NAIVE and GATED both render
  // their own Smile, so a shared static id would collide. `useId()`
  // returns a stable, document-unique string; colons (which `useId`
  // includes) are valid in modern SVG `url(#…)` references but we
  // strip them defensively for the widest browser support.
  const clipId = `smile-clip-${useId().replace(/:/g, "")}`;

  // Compositor-only y-axis transition via the Web Animations API. When
  // `yRange` changes (maturity switch or envelope expansion), Smile
  // re-renders content at the NEW range immediately, then runs a WAAPI
  // animation on the inner chart group with two keyframes: an initial
  // transform that visually maps new positions back to where the same
  // data lived under the OLD range, and identity. The interpolation
  // runs on the GPU compositor — zero React re-renders, zero
  // main-thread style/layout/paint per animation frame, and crucially
  // **no force reflow** (which the prior CSS-transition implementation
  // required to commit the initial transform before transitioning).
  // The animation appears in DevTools' Animations panel, making the
  // compositor-only behaviour verifiable at a glance.
  //
  // The math (derived analytically):
  //   sy = (newMax − newMin) / (oldMax − oldMin)
  //   ty = MARGIN.top × (1 − sy) + innerH × (oldMax − newMax) / (oldMax − oldMin)
  //
  // Applied around `transform-origin: 0 0` with `transform-box: view-box`
  // (the SVG default for non-root `<g>`). The origin is at the SVG
  // view-box's top-left, NOT the inner group's bounding box — view-box
  // is fixed across content changes, fill-box would force the browser
  // to recompute the element's bounding box whenever its content
  // changes (200 circles × 2 panels per 5 Hz tick) which triggered
  // unattributed document-wide reflows in earlier traces. The
  // `MARGIN.top × (1 − sy)` term in ty compensates for the fact that
  // the chart content is offset by MARGIN.top in view-box coords via
  // the parent `<g transform="translate(...)">`.
  //
  // Replaces the previous `useAnimatedRange` rAF approach which cost
  // ~50 ms of main-thread work over each 300 ms transition. Reduced-
  // motion users get an instant snap (duration 0) — animation is a
  // visual aid, not load-bearing for comprehension.
  //
  // Note on shape distortion: scaleY visually stretches dots into ovals
  // and curves vertically during the transition. This is correct
  // semantically — it represents the y-axis zoom — and matches the
  // visual idiom every chart library uses for the same transition.
  // After 300 ms the transform is identity and shapes are normal.
  const innerGroupRef = useRef<SVGGElement>(null);
  const prevYRangeRef = useRef<readonly [number, number]>([yRange0, yRange1]);
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const prev = prevYRangeRef.current;
    if (prev[0] === yRange0 && prev[1] === yRange1) return;
    const group = innerGroupRef.current;
    if (group === null) return;

    const [oldMin, oldMax] = prev;
    const span = oldMax - oldMin;
    if (!Number.isFinite(span) || span === 0) {
      // Defensive: degenerate prior range — skip animation, just snap.
      prevYRangeRef.current = [yRange0, yRange1];
      return;
    }
    const sy = (yRange1 - yRange0) / span;
    const ty = MARGIN.top * (1 - sy) + (innerH * (oldMax - yRange1)) / span;

    // Respect `prefers-reduced-motion`. With duration 0 the animation
    // snaps to the final state instantly — same end result, no motion.
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    // Cancel any in-flight animation — interruption case (rare for the
    // demo's user-button-triggered maturity selector, but correct).
    animationRef.current?.cancel();

    animationRef.current = group.animate(
      [
        { transform: `translateY(${ty}px) scaleY(${sy})` },
        { transform: "translateY(0px) scaleY(1)" },
      ],
      {
        duration: prefersReducedMotion ? 0 : 300,
        easing: "cubic-bezier(.4, 0, .2, 1)",
        // `fill: "forwards"` keeps the final transform applied after
        // completion — the element stays at identity until the next
        // animation runs.
        fill: "forwards",
      },
    );

    prevYRangeRef.current = [yRange0, yRange1];
  }, [yRange0, yRange1, innerH]);

  // Cancel any in-flight animation on unmount so the next mount starts
  // clean (relevant for Strict Mode double-mount and panel remounts).
  useEffect(() => {
    return () => {
      animationRef.current?.cancel();
    };
  }, []);

  return (
    // Wrapper div hosts the SVG and the HTML hover overlay as siblings.
    // The overlay can't live inside the SVG: `backdrop-filter` doesn't
    // apply to SVG elements in current browsers (`BackgroundImage` was
    // dropped from Chromium years ago). Placing the overlay as an
    // absolutely-positioned HTML sibling restores backdrop-blur as a
    // compositor effect (Chromium 76+, Safari 9+) while keeping the
    // chart itself in SVG.
    //
    // Pointer handlers attach to the wrapper, not the SVG. The overlay
    // sets `pointer-events: none` so events tunnel through to the
    // wrapper, where the bounding rect (identical to the SVG's, since
    // the SVG fills the wrapper) drives the x → k inversion.
    <div
      className="relative"
      style={{ width, height, cursor: "crosshair" }}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label="SVI smile plot"
        style={{ display: "block" }}
      >
        {/* ClipPath confines the dots, curves, and hover cursor to the
            inner chart rectangle so they don't bleed above or below
            during y-range transitions (maturity change / envelope
            expansion) or when out-of-domain IVs briefly appear before
            the sticky range catches up. Axes/grid stay outside the
            clip so labels remain readable. */}
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={innerW} height={innerH} />
          </clipPath>
        </defs>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* Static structure — grid, axes, ticks, labels. Memoised so
              it doesn't reconcile when only the curve / dots change. */}
          <StaticAxes
            x={x}
            y={y}
            xTicks={xTicks}
            yTicks={yTicks}
            innerW={innerW}
            innerH={innerH}
          />

          <g
            ref={innerGroupRef}
            clipPath={`url(#${clipId})`}
            style={{
              // Explicit `view-box` (the SVG default for non-root `<g>`)
              // pivots `transform-origin: 0 0` at the SVG view-box's
              // own top-left, NOT at the inner group's bounding box.
              // Using `fill-box` here required the browser to recompute
              // this element's bounding box every time its inner content
              // changed (200 circles + path `d` per 5 Hz tick), which
              // triggered the document-wide unattributed forced reflow
              // visible in the Performance Insights trace. View-box has
              // a fixed origin per render, so transform reference is
              // stable across content updates. The MARGIN.top offset
              // is baked into the WAAPI transform's `ty` keyframe in
              // the useLayoutEffect above.
              transformBox: "view-box",
              transformOrigin: "0 0",
            }}
          >
            {/* Cross-view hover cursor — vertical line at the hovered k.
                Rendered before the curves so they sit visually on top.
                `hoveredK` is App-owned state; the same line appears on
                both smiles (and corresponds to the highlighted row in
                the option chain) regardless of which view initiated the
                hover. Stroke colour reinforces panel identity: red on
                NAIVE, green on GATED — same as the chip rail and
                panel-header accents. */}
            {props.hoveredK !== null &&
              props.hoveredK >= xRange0 &&
              props.hoveredK <= xRange1 && (
                <line
                  x1={x(props.hoveredK)}
                  x2={x(props.hoveredK)}
                  y1={0}
                  y2={innerH}
                  stroke={
                    props.cursorTone === "stale"
                      ? CURSOR_STROKE_STALE
                      : CURSOR_STROKE_OK
                  }
                  strokeWidth={1}
                  strokeDasharray="2 2"
                  opacity={0.75}
                  pointerEvents="none"
                />
              )}

            {/* Observed quotes — dots. tornStrikes flags red on naive panel
                when curve and dot disagree by more than the threshold.
                Rendered before the fit curve so the curve sits ON TOP of
                the dots — at 200 strikes the dots form a near-continuous
                mass and would otherwise hide the fit entirely (most
                visible in GATED where the fit hugs the dots). With the
                fit on top, viewers see a thin blue ribbon tracing through
                the dot field, and the dots remain visible around the
                ribbon. When NAIVE under shock tears, dots and fit
                separate spatially — both fully visible. */}
            {quotes.map((q, i) => {
              const torn = props.tornStrikes?.[i] ?? false;
              return (
                <circle
                  key={`q-${q.k.toFixed(4)}`}
                  cx={x(q.k)}
                  cy={y(q.iv)}
                  r={2.5}
                  fill={torn ? "oklch(0.66 0.20 28)" : "oklch(0.94 0.008 240)"}
                  stroke={
                    torn ? "oklch(0.66 0.20 28)" : "oklch(0.30 0.014 240)"
                  }
                  strokeWidth={0.5}
                />
              );
            })}

            {/* Fitted curve (accent-info blue solid) — the panel's recovered SVI. */}
            {fittedPath !== "" && (
              <path
                d={fittedPath}
                fill="none"
                stroke="oklch(0.70 0.13 230)"
                strokeWidth={1.5}
              />
            )}
          </g>
        </g>
      </svg>

      {/* HTML hover overlay — sibling to the SVG, absolutely positioned
          at the top-left of the chart's INNER area (inside the
          y-axis-label margin, not over it). Compositor-only visual
          effects: alpha-channel composition (`bg-bg-elev/70`) and
          `backdrop-filter: blur(...)` (Tailwind `backdrop-blur-md`).
          The SVG underneath shows through softly so the chart stays
          legible while the overlay reads as floating above it. */}
      {overlay !== null && (
        <HoverOverlay
          {...overlay}
          leftPx={MARGIN.left + 8}
          topPx={MARGIN.top + 8}
        />
      )}

      {/* Legend — names the chart elements. Pinned top-right of the
          chart interior with the same MARGIN+8 inset as the hover
          overlay on the left, so the two HTML siblings sit
          symmetrically. Same translucent backdrop-blur treatment as
          the overlay for visual register match. The `torn` swatch
          surfaces only on the NAIVE panel — GATED never produces torn
          dots by the substrate's invariant, so the entry would
          mislead the viewer about possible states there. */}
      <SmileLegend
        rightPx={MARGIN.right + 8}
        topPx={MARGIN.top + 8}
        showTorn={props.cursorTone === "stale"}
      />
    </div>
  );
}

function SmileLegend({
  rightPx,
  topPx,
  showTorn,
}: {
  readonly rightPx: number;
  readonly topPx: number;
  readonly showTorn: boolean;
}): ReactElement {
  return (
    <div
      className="pointer-events-none absolute flex items-center gap-3 rounded border border-border/60 bg-bg-elev/70 px-2 py-1 font-mono text-[10px] text-fg-muted backdrop-blur-md"
      style={{ right: rightPx, top: topPx }}
    >
      <span className="flex items-center gap-1.5">
        <svg width="14" height="6" aria-hidden="true">
          <title>fit curve</title>
          <line
            x1={0}
            x2={14}
            y1={3}
            y2={3}
            stroke="oklch(0.70 0.13 230)"
            strokeWidth={1.5}
          />
        </svg>
        <span>fit</span>
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="6" height="6" aria-hidden="true">
          <title>observed quote</title>
          <circle cx={3} cy={3} r={2.2} fill="oklch(0.94 0.008 240)" />
        </svg>
        <span>observed</span>
      </span>
      {showTorn && (
        <span
          className="flex items-center gap-1.5"
          title="dots paint red where the fit-vs-observation mismatch crosses the in-panel coherence threshold — visible signature of the snapshot tear"
        >
          <svg width="6" height="6" aria-hidden="true">
            <title>torn (fit/obs mismatch)</title>
            <circle cx={3} cy={3} r={2.2} fill="oklch(0.66 0.20 28)" />
          </svg>
          <span>torn</span>
        </span>
      )}
    </div>
  );
}

type OverlayContent = {
  readonly k: number;
  readonly fitIv: number | null;
  readonly obsIv: number | null;
  readonly miss: number | null;
  readonly gAtK: number | null;
};

function computeOverlay(
  hoveredK: number,
  fittedParams: SviParams | undefined,
  quotes: readonly SmileQuote[],
  timeToExpiry: number,
): OverlayContent {
  let fitIv: number | null = null;
  let gAtK: number | null = null;
  if (fittedParams !== undefined) {
    const wFit = w(hoveredK, fittedParams);
    if (Number.isFinite(wFit) && wFit > 0) {
      fitIv = varianceToIv(wFit, timeToExpiry);
    }
    const g = gatheralG(hoveredK, fittedParams);
    if (Number.isFinite(g)) gAtK = g;
  }

  // Find the quote whose k is closest to hoveredK; accept only within
  // tolerance so the overlay reads "—" when the cursor is between
  // strike clusters rather than pinning to a distant quote.
  let nearest: SmileQuote | null = null;
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const q of quotes) {
    const d = Math.abs(q.k - hoveredK);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = q;
    }
  }
  const obsIv =
    nearest !== null && nearestDist <= NEAREST_QUOTE_K_TOLERANCE
      ? nearest.iv
      : null;
  const miss = fitIv !== null && obsIv !== null ? fitIv - obsIv : null;

  return { k: hoveredK, fitIv, obsIv, miss, gAtK };
}

function HoverOverlay({
  k,
  fitIv,
  obsIv,
  miss,
  gAtK,
  leftPx,
  topPx,
}: OverlayContent & { readonly leftPx: number; readonly topPx: number }) {
  return (
    <div
      className="pointer-events-none absolute w-32 rounded border border-border/60 bg-bg-elev/70 px-2 py-1.5 backdrop-blur-md"
      style={{ left: leftPx, top: topPx }}
      // Position is inline because the chart's left margin (the y-axis
      // label area) is a module-level pixel constant (`MARGIN.left`),
      // not a Tailwind spacing unit. Slight opacity (`bg-bg-elev/70`)
      // + `backdrop-filter: blur(12px)` (Tailwind `backdrop-blur-md`)
      // compose on the GPU compositor in modern Chromium / Safari —
      // alpha-channel composition and `backdrop-filter` are both
      // compositor-only when no transform descendants force a fallback.
    >
      <OverlayRow label="k" value={formatSignedDecimal(k, 3)} />
      <OverlayRow
        label="IV fit"
        value={fitIv === null ? "—" : `${(fitIv * 100).toFixed(2)}%`}
      />
      <OverlayRow
        label="IV obs"
        value={obsIv === null ? "—" : `${(obsIv * 100).toFixed(2)}%`}
      />
      <OverlayRow
        label="miss"
        value={miss === null ? "—" : formatSignedPercent(miss, 2)}
        valueTone={
          miss === null ? "fg" : Math.abs(miss) > 0.005 ? "stale" : "fg"
        }
      />
      <OverlayRow
        label="g(k)"
        value={gAtK === null ? "—" : formatSignedDecimal(gAtK, 3)}
        valueTone={gAtK === null ? "fg" : gAtK < 0 ? "stale" : "fg"}
      />
    </div>
  );
}

function OverlayRow({
  label,
  value,
  valueTone = "fg",
}: {
  label: string;
  value: string;
  valueTone?: "fg" | "stale";
}) {
  const valueClass = valueTone === "stale" ? "text-accent-stale" : "text-fg";
  return (
    <div className="flex items-baseline justify-between font-mono text-[10px] leading-tight">
      <span className="text-fg-muted">{label}</span>
      <span className={`tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

function formatSignedDecimal(v: number, digits: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}`;
}

function formatSignedPercent(v: number, digits: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(digits)}%`;
}

// Memo the Smile so the parent Panel can re-render at compute cadence
// without forcing the SVG subtree to rebuild. All props are primitives
// or memo'd refs at the call-site (Panel.tsx), so the default
// shallow-compare in `memo` skips reconciliation cleanly. The SVG path
// `d` attribute updates are the largest layout cost per re-render; this
// is the lever that turns the 5 Hz boundary into a real render cap.
export const Smile = memo(SmileImpl);

// Static SVG: grid lines, axis lines, tick marks, tick labels, axis
// title. Depends only on the scales (which are stable across ticks)
// and chart geometry. `memo` skips reconciliation of these ~30 nodes
// per chart on every data update.
type StaticAxesProps = {
  readonly x: ReturnType<typeof scaleLinear<number>>;
  readonly y: ReturnType<typeof scaleLinear<number>>;
  readonly xTicks: readonly number[];
  readonly yTicks: readonly number[];
  readonly innerW: number;
  readonly innerH: number;
};

const StaticAxes = memo(function StaticAxes({
  x,
  y,
  xTicks,
  yTicks,
  innerW,
  innerH,
}: StaticAxesProps) {
  return (
    <>
      {/* Grid */}
      {yTicks.map((t) => (
        <line
          key={`gy-${t}`}
          x1={0}
          x2={innerW}
          y1={y(t)}
          y2={y(t)}
          stroke="oklch(0.30 0.014 240)"
          strokeWidth={0.5}
        />
      ))}
      {xTicks.map((t) => (
        <line
          key={`gx-${t}`}
          y1={0}
          y2={innerH}
          x1={x(t)}
          x2={x(t)}
          stroke="oklch(0.30 0.014 240)"
          strokeWidth={0.5}
        />
      ))}

      {/* X axis */}
      <line
        x1={0}
        x2={innerW}
        y1={innerH}
        y2={innerH}
        stroke="oklch(0.40 0.014 240)"
        strokeWidth={1}
      />
      {xTicks.map((t) => (
        <g key={`x-${t}`} transform={`translate(${x(t)},${innerH})`}>
          <line y2={4} stroke="oklch(0.40 0.014 240)" strokeWidth={1} />
          <text
            y={16}
            textAnchor="middle"
            fontSize={10}
            fill="oklch(0.68 0.012 240)"
            style={{
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      {/* Y axis */}
      <line
        x1={0}
        x2={0}
        y1={0}
        y2={innerH}
        stroke="oklch(0.40 0.014 240)"
        strokeWidth={1}
      />
      {yTicks.map((t) => (
        <g key={`y-${t}`} transform={`translate(0,${y(t)})`}>
          <line x2={-4} stroke="oklch(0.40 0.014 240)" strokeWidth={1} />
          <text
            x={-8}
            y={3}
            textAnchor="end"
            fontSize={10}
            fill="oklch(0.68 0.012 240)"
            style={{
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {(t * 100).toFixed(0)}%
          </text>
        </g>
      ))}
    </>
  );
});

function buildCurvePath(
  params: SviParams,
  xScale: ReturnType<typeof scaleLinear<number>>,
  yScale: ReturnType<typeof scaleLinear<number>>,
  timeToExpiry: number,
  xRange: readonly [number, number],
): string {
  const [kMin, kMax] = xRange;
  let d = "";
  let started = false;
  for (let i = 0; i < FIT_SAMPLES; i++) {
    const t = i / (FIT_SAMPLES - 1);
    const k = kMin + t * (kMax - kMin);
    const variance = w(k, params);
    if (!Number.isFinite(variance) || variance <= 0) continue;
    const iv = varianceToIv(variance, timeToExpiry);
    if (!Number.isFinite(iv)) continue;
    const cx = xScale(k);
    const cy = yScale(iv);
    // d3-scale returns `undefined` (not NaN) when its input is non-finite
    // or out-of-domain in some configurations. Guard explicitly.
    if (
      typeof cx !== "number" ||
      typeof cy !== "number" ||
      !Number.isFinite(cx) ||
      !Number.isFinite(cy)
    ) {
      continue;
    }
    d += `${started ? "L" : "M"}${cx.toFixed(2)} ${cy.toFixed(2)}`;
    started = true;
  }
  return d;
}
