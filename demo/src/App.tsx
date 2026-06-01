// Demo entry component. Wires:
//
//   - useFeed: synthetic chain feed
//   - useNaiveFit + useGatedFit: paired worker-backed fit-state hooks
//   - Vertical-panel + right-rail layout: NAIVE (top), ORACAUS (bottom),
//     option chain (right rail). 100vh / 100vw, no page scroll. Trading-
//     workstation aesthetic — every pixel earns its place.
//
// Information architecture:
//   - Top bar (~56 px): title + status (tick/spot/seed) + controls inline
//   - Main (flex-1):
//       - Left column (flex-1): NAIVE panel above ORACAUS panel, equal split
//       - Right rail (fixed 420 px): OPTION CHAIN, full-height
//
// Below 1024 × 700 the side-by-side rail can't fit; we render a notice
// rather than degrade the message — comparison is the demo's whole point,
// and a stacked-on-mobile version would dilute it.
//
// The demo's central message:
//   Both panels run the SAME worker against the SAME feed. Only the
//   synchronisation strategy differs. Naive renders dots and curves
//   from independent state slots → tearing. Oracaus renders them as a
//   coherent (input, output) pair via the library → no tearing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trackEvent } from "./analytics.js";
import type { RegionId } from "./commentary/region.js";
import { useCommentary } from "./commentary/use-commentary.js";
import { AdvancedControls } from "./components/AdvancedControls.js";
import { CommentaryToastStack } from "./components/CommentaryToastStack.js";
import { Controls, DISPLAY_MATURITIES } from "./components/Controls.js";
import { GithubIcon, LinkedInIcon, NpmIcon } from "./components/icons.js";
import { MismarkSparkline } from "./components/MismarkSparkline.js";
import { OptionChainTable } from "./components/OptionChainTable.js";
import { Panel } from "./components/Panel.js";
import { buildExpiryLadder, readFeedSession } from "./feed.js";
import { useFeed } from "./hooks/use-feed.js";
import { useGatedFit } from "./hooks/use-gated-fit.js";
import { projectSurfaceSnapshot, useNaiveFit } from "./hooks/use-naive-fit.js";
import { useThrottled } from "./hooks/use-throttled.js";
import { computeSnapshotLag } from "./metrics.js";
import { computeMisses, summariseMisses } from "./svi-mismark.js";
import { projectMaturity } from "./types.js";

// Single display-clock interval. Every UI consumer downstream of App
// (Panel, OptionChainTable, MismarkSparkline) reads state through a
// useThrottled boundary at this cadence — the panel state arrives as
// an all-or-nothing composite, so every paint reads a coherent
// snapshot. 5 Hz / 200 ms matches the trading-desk display-throttle
// cadence documented in CLAUDE.md §The three rates and is the same
// boundary `useFeed` and `useNaiveFit` use internally (so worker-rate
// state and feed-rate state both arrive at consumers via the same
// clock).
const DISPLAY_REFRESH_INTERVAL_MS = 200;

// Viewport thresholds below which the toolbar (~1190 px) + the rail
// (≥400 px) + the chart column (≥600 px) can't compose without
// clipping or compromising the demo's message. 1280 × 700 is the
// Tailwind `xl` breakpoint and the practical floor for trading-
// workstation displays.
const MIN_VIEWPORT_WIDTH = 1280;
const MIN_VIEWPORT_HEIGHT = 700;

function makeSviWorker(): Worker {
  return new Worker(new URL("./worker/svi-worker.ts", import.meta.url), {
    type: "module",
  });
}

// 50 × 200 lands at ~58 ms p99 warm on M-series Mac (`npm run bench`) —
// inside the [50, 150] ms Form 2 zone (at its lower edge), matching
// SPX-style surfaces' typical 30–60 expiry count. Strikes-per-slice is
// constant; the configurable axis is the expiry count (Controls selector).
const DEFAULT_N_EXPIRIES_FITTED = 50;
const N_STRIKES_PER_SLICE = 200;

// Default displayed maturity — 1Y, the standard SPX "1Y vol" reference
// point. The panel projects whichever index in the configured ladder is
// closest to this value; works correctly across nExpiriesFitted changes.
const DEFAULT_DISPLAY_MATURITY_YEARS = 1.0;

// Project a target maturity-in-years onto the configured expiry ladder by
// closest absolute difference. Load-bearing for the
// `displayMaturityIdx = f(nExpiriesFitted, displayMaturityYears)` derived
// state: when the user changes `nExpiriesFitted` (e.g. 30 → 70), the
// ladder reshapes and the previous integer index no longer points at the
// intended maturity. Re-projecting against the new ladder keeps the
// displayed maturity stable in years (the user-meaningful axis) across
// expiry-count changes. O(N) scan; N ≤ 80; called from a `useMemo` so
// it only re-runs when its inputs change.
function findClosestMaturityIdx(
  ladder: readonly number[],
  targetYears: number,
): number {
  let bestIdx = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ladder.length; i++) {
    const T = ladder[i];
    if (T === undefined) continue;
    const diff = Math.abs(T - targetYears);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// Smile chart axis ranges.
//
// X is constant (log-moneyness window the demo paints over). Y adapts to
// the displayed maturity — at 1M (T ≈ 1/12) the SVI smile's ATM IV scales
// roughly as √(b·σ/T + a*), pushing wings outside the [0.15, 0.55] range
// that fits 1Y. Without the adaptation, short-T slices render with most
// of their dots clipped above the chart top.
//
// The synthetic feed's anchor parameters (`feed.ts` — `SPOT_INITIAL` /
// `RawSviParams` anchors) are mirrored here so the range is purely a
// function of T at module level (no React state). The OU walk around
// the anchors is small enough that actual per-tick IVs stay inside the
// padded envelope across the run.
const SMILE_X_RANGE: readonly [number, number] = [-1.0, 1.0];
const SMILE_ANCHOR_PARAMS = {
  a: 0.04,
  b: 0.1,
  rho: -0.5,
  m: 0,
  sigma: 0.2,
};

function computeSmileYRange(
  T: number,
  xRange: readonly [number, number],
): readonly [number, number] {
  let minIv = Number.POSITIVE_INFINITY;
  let maxIv = Number.NEGATIVE_INFINITY;
  const N = 50;
  const [kMin, kMax] = xRange;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const k = kMin + t * (kMax - kMin);
    const km = k - SMILE_ANCHOR_PARAMS.m;
    // raw-SVI w(k) with `a_T = a* · T` (matches feed.ts's deterministic
    // T-scaling on `a` to keep the TRUE surface calendar-arb-free).
    const variance =
      SMILE_ANCHOR_PARAMS.a * T +
      SMILE_ANCHOR_PARAMS.b *
        (SMILE_ANCHOR_PARAMS.rho * km +
          Math.hypot(km, SMILE_ANCHOR_PARAMS.sigma));
    if (variance > 0) {
      const iv = Math.sqrt(variance / T);
      if (iv < minIv) minIv = iv;
      if (iv > maxIv) maxIv = iv;
    }
  }
  if (!Number.isFinite(minIv) || !Number.isFinite(maxIv)) {
    return [0.15, 0.55];
  }
  // Pad ±15 % of span (or 2 IV-points absolute floor). Floor lower bound
  // at 0 — IVs are non-negative.
  const span = maxIv - minIv;
  const pad = Math.max(span * 0.15, 0.02);
  return [Math.max(0, minIv - pad), maxIv + pad];
}

export function App() {
  const sessionFromUrl = useMemo(readFeedSession, []);
  const [seed, setSeed] = useState(sessionFromUrl.seed);
  const [nExpiriesFitted, setNExpiriesFitted] = useState(
    DEFAULT_N_EXPIRIES_FITTED,
  );
  const [displayMaturityYears, setDisplayMaturityYears] = useState(
    DEFAULT_DISPLAY_MATURITY_YEARS,
  );
  // Intent-input state — the user-controlled repair-mode toggle. Default
  // "on" matches the production-realistic pipeline (the pre-intent
  // behaviour). The substrate cancels in-flight gated compute on change
  // and restarts against the new mode; naive lets in-flight complete
  // against the old mode before posting the next tick with the new mode.
  const [repairMode, setRepairMode] = useState<"on" | "off">("on");

  // Bumps every time `repairMode` (the only intent input) changes. The
  // Oracaus panel uses this to flash its fitting chip — `isComputing`
  // stays continuously true across cancel-and-restart (worker aborts
  // and immediately restarts) so the chip text alone never changes;
  // the bumped key gives the panel a one-shot trigger to surface the
  // event visibly.
  const [intentChangedKey, setIntentChangedKey] = useState(0);
  const prevRepairModeRef = useRef(repairMode);
  useEffect(() => {
    if (prevRepairModeRef.current !== repairMode) {
      prevRepairModeRef.current = repairMode;
      setIntentChangedKey((k) => k + 1);
    }
  }, [repairMode]);

  // Cross-view hover state — log-moneyness currently hovered. Owned here
  // so all three views stay in lock-step: hovering either smile or any
  // option-chain row updates this single value, and all three views read
  // from it. The dashed cursor line appears on BOTH smile panels; the
  // matching row in the chain table highlights. Demonstrates that the
  // substrate's emit is the alignment point for downstream synchronous
  // derivations (the overlay's `IV fit / IV obs / miss / g(k)` numbers
  // are pure functions of the substrate-emitted `(slice, params, T)`
  // tuple plus hovered k — see CLAUDE.md §Demo §Cross-view hover overlay).
  //
  // Deliberately NOT routed through `useThrottled` — hover should feel
  // immediate. Memoised consumer components (`Panel`, `Smile`,
  // `OptionChainTable`) bound re-render cost.
  //
  // Persisted across `displayMaturityYears` changes: the cursor visually
  // stays at the same k on the new smile, letting viewers compare
  // diagnostics across tenors by hovering and then switching slice.
  const [hoveredK, setHoveredK] = useState<number | null>(null);

  // Stage 11 — pointer-aware insight narration. Tracks which demo region
  // is currently under the pointer; the hook's debouncer promotes a
  // stable 1.5 s+ hover into a commit; the commit gates an insight
  // toast via the polite-enqueue rule (drops insights during shock /
  // ack chains; fires deferred when the system quiets).
  //
  // No visual tint on the region itself — the tint indicator was
  // reverted post-implementation as audience-mismatched. The toast
  // text names the region ("Naive's mismark…", "Oracaus never shows…"),
  // which is the only anchor the senior audience needs.
  //
  // State lives outside the 5 Hz `useThrottled` boundary so hover
  // commits feel responsive. Setters are stable via `useCallback` so
  // per-region `onMouseEnter` / `onMouseLeave` props are reference-
  // stable across App re-renders.
  const [hoveredRegion, setHoveredRegion] = useState<RegionId | null>(null);
  const enterRegion = useCallback(
    (region: RegionId) => setHoveredRegion(region),
    [],
  );
  const leaveRegion = useCallback(
    (region: RegionId) =>
      setHoveredRegion((current) => (current === region ? null : current)),
    [],
  );

  // Initial-pointer detection. `mouseenter` only fires on transitions
  // — a page loaded with the pointer already over a region never
  // triggers it. This one-shot document-level listener fires on the
  // first pointer movement after mount, finds which region the
  // pointer is currently over via `elementFromPoint` + a walk up the
  // DOM to the nearest `data-region` ancestor, and sets
  // `hoveredRegion` once. After that, the regular `onMouseEnter` /
  // `onMouseLeave` handle every subsequent transition. The listener
  // self-removes after the first event; effect cleanup also removes
  // (defensive — Strict Mode double-mount).
  useEffect(() => {
    let detected = false;
    const detectInitial = (event: MouseEvent) => {
      if (detected) return;
      detected = true;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      let node: Element | null = target;
      while (node && !(node as HTMLElement).dataset?.region) {
        node = node.parentElement;
      }
      const region = (node as HTMLElement | null)?.dataset?.region;
      if (region) setHoveredRegion(region as RegionId);
      document.removeEventListener("mousemove", detectInitial);
    };
    document.addEventListener("mousemove", detectInitial);
    return () => {
      document.removeEventListener("mousemove", detectInitial);
    };
  }, []);

  // Advanced-controls modal — creator-side panel (seed override, recording
  // status). Surfaced via `?` keyboard shortcut rather than the toolbar
  // because it's an author tool, not a visitor tool. The single-key
  // convention matches "show help / advanced" idioms in dev tools and is
  // discoverable to curious visitors without burdening the toolbar.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "?") return;
      const target = event.target as HTMLElement | null;
      // Defensive: don't intercept "?" when the user is typing into a
      // form control. The main demo has none, but the advanced modal
      // itself has a seed input — typing "?" there should reach the
      // field, not toggle the modal.
      if (target !== null) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
          return;
        }
      }
      event.preventDefault();
      setAdvancedOpen((open) => !open);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const feed = useFeed({
    seed,
    initialTickRateHz: 50,
    nExpiriesFitted,
    nStrikesPerSlice: N_STRIKES_PER_SLICE,
  });

  // Derive the ladder + display index + actual displayed maturity (in
  // years) from (nExpiriesFitted, displayMaturityYears). One useMemo so
  // the ladder is built once per change; `displayMaturityT` is the
  // value actually painted (the closest entry on the ladder, which may
  // differ from the user-requested `displayMaturityYears` when the
  // ladder is sparse).
  const { displayMaturityIdx, displayMaturityT } = useMemo(() => {
    const ladder = buildExpiryLadder(nExpiriesFitted);
    const idx = findClosestMaturityIdx(ladder, displayMaturityYears);
    return { displayMaturityIdx: idx, displayMaturityT: ladder[idx] ?? 1 };
  }, [nExpiriesFitted, displayMaturityYears]);

  // Panel-title expiry label — the user-selected tenor (1M / 3M / 6M /
  // 1Y / 2Y) appearing alongside "Vol smile @" in each panel header.
  // Derived from `displayMaturityYears` (the user's exact selection),
  // not `displayMaturityT` (the closest ladder entry that's actually
  // rendered) — what the user clicked is what the title shows.
  const expiryLabel =
    DISPLAY_MATURITIES.find((m) => m.years === displayMaturityYears)?.label ??
    "1Y";

  // Anchor-based smile y-range — baseline for the current maturity.
  // Pure function of T using the synthetic feed's anchor params.
  const anchorYRange = useMemo(
    () => computeSmileYRange(displayMaturityT, SMILE_X_RANGE),
    [displayMaturityT],
  );

  // Sticky y-range — starts at the anchor range, expands outward when
  // the observed envelope overflows, never shrinks within a single
  // maturity selection. Hysteresis avoids axis-tick jiggling that would
  // otherwise fire every 5 Hz throttle flush as the OU walk perturbs
  // IVs. Reset to the anchor when maturity changes (a fresh baseline
  // for the new T).
  const [stickyYRange, setStickyYRange] =
    useState<readonly [number, number]>(anchorYRange);
  useEffect(() => {
    setStickyYRange(anchorYRange);
  }, [anchorYRange]);

  const naiveWorkerFactory = useCallback(makeSviWorker, []);
  const gatedWorkerFactory = useCallback(makeSviWorker, []);

  // Intent reference-stable across re-renders unless the user toggles
  // repair-mode. The library compares intent by reference identity —
  // memoising prevents spurious cancel-and-restart cycles every render.
  const intent = useMemo(() => ({ repairMode }), [repairMode]);

  const naive = useNaiveFit(intent, naiveWorkerFactory, feed.subscribeTick);
  const gated = useGatedFit(intent, gatedWorkerFactory, feed.subscribeTick);

  // Project surface outputs to single-slice shapes the existing UI
  // components consume. The full surface is computed and committed
  // atomically; the display projection is a free re-read.
  //
  // `nExpiriesFitted` is passed as the expected-surface-size so a
  // stale surface (left over from the previous expiry-count setting)
  // is filtered out for the brief window during which the worker is
  // catching up. Without that filter, `perMaturity[displayMaturityIdx]`
  // picks the wrong slice during the transition and pollutes the
  // sticky-yRange envelope. See `projectMaturity`'s docstring.
  const naiveDisplayData = useMemo(
    () => projectMaturity(naive.data, displayMaturityIdx, nExpiriesFitted),
    [naive.data, displayMaturityIdx, nExpiriesFitted],
  );
  const gatedDisplayData = useMemo(
    () => projectMaturity(gated.data, displayMaturityIdx, nExpiriesFitted),
    [gated.data, displayMaturityIdx, nExpiriesFitted],
  );
  // The naive panel's "latest input view" is the 5 Hz throttled feed
  // tick — same source the Oracaus panel's lag chip (currentTickIndex)
  // uses. Single source of truth for "current displayed tick"; no
  // separate antiphased 5 Hz timer can ever drift behind it. FeedTick
  // is structurally assignable to SurfaceSnapshot (extra spot/timestamp
  // fields are ignored by the projection).
  const naiveDisplayInputs = useMemo(
    () =>
      projectSurfaceSnapshot(feed.tick, displayMaturityIdx, nExpiriesFitted),
    [feed.tick, displayMaturityIdx, nExpiriesFitted],
  );
  const gatedDisplayInputs = useMemo(
    () =>
      projectSurfaceSnapshot(
        gated.latestInputs,
        displayMaturityIdx,
        nExpiriesFitted,
      ),
    [gated.latestInputs, displayMaturityIdx, nExpiriesFitted],
  );

  // Composite throttle — every Panel prop flushes together on the
  // 5 Hz boundary so the chart, stats ribbon, status chips, and mismark
  // metric all reflect the same instant. Without this, naive.data (set
  // on worker response, ~13 Hz at default compute) and naiveDisplayInputs
  // (set on feed tick, now 5 Hz) updated at different cadences — the
  // chart felt "ahead" of the metrics ribbon, reading as flicker.
  //
  // `currentTickIndex` is part of the composite so the per-mode lag
  // formula (see `demo/src/metrics.ts:computeSnapshotLag` — naive uses
  // `abs(latestInputs - data)`, gated uses `max(0, currentTickIndex -
  // data)`) and the chart data are both from the same flush boundary;
  // otherwise feed.tick's own 5 Hz timer and useThrottled's 5 Hz timer
  // would be slightly out of phase, letting the lag metric momentarily
  // disagree with the chart.
  const naivePanelState = useThrottled(
    useMemo(
      () => ({
        data: naiveDisplayData,
        latestInputs: naiveDisplayInputs,
        isComputing: naive.isComputing,
        pendingCount: naive.pendingCount,
        currentTickIndex: feed.tick?.tickIndex,
      }),
      [
        naiveDisplayData,
        naiveDisplayInputs,
        naive.isComputing,
        naive.pendingCount,
        feed.tick?.tickIndex,
      ],
    ),
    DISPLAY_REFRESH_INTERVAL_MS,
  );
  const gatedPanelState = useThrottled(
    useMemo(
      () => ({
        data: gatedDisplayData,
        latestInputs: gatedDisplayInputs,
        isComputing: gated.isComputing,
        currentTickIndex: feed.tick?.tickIndex,
        intentChangedKey,
      }),
      [
        gatedDisplayData,
        gatedDisplayInputs,
        gated.isComputing,
        feed.tick?.tickIndex,
        intentChangedKey,
      ],
    ),
    DISPLAY_REFRESH_INTERVAL_MS,
  );

  // Observed-IV envelope across both panels' currently-rendered slices.
  // The y-axis sticky range expands outward when this envelope falls
  // outside it. Recomputed at the panel-state cadence (5 Hz throttle);
  // O(N) over each slice's quotes (N = 200 by default) per panel
  // = ~2 000 number comparisons per second, trivial.
  //
  // Two slice sources are unioned so the y-axis fits whichever panel
  // shows the larger envelope (rare in steady state — both panels render
  // the same maturity — but NAIVE's tear can briefly produce dots from a
  // newer snapshot before its fit lands, momentarily widening the
  // envelope by the OU drift since the last fit).
  const observedEnvelope = useMemo<readonly [number, number] | null>(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const slices = [
      naivePanelState.latestInputs?.slice,
      gatedPanelState.data?.sourceSlice,
    ];
    for (const slice of slices) {
      if (slice === undefined) continue;
      for (const q of slice.quotes) {
        if (q.impliedVol < min) min = q.impliedVol;
        if (q.impliedVol > max) max = q.impliedVol;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : null;
  }, [naivePanelState.latestInputs, gatedPanelState.data]);

  // Expand stickyYRange outward when the observed envelope overflows.
  // Strict inequality + padding keeps the chart from "breathing" by a
  // pixel each tick — only real overflows trigger an expansion.
  useEffect(() => {
    if (observedEnvelope === null) return;
    const [eMin, eMax] = observedEnvelope;
    const span = eMax - eMin;
    const pad = Math.max(span * 0.1, 0.015);
    const paddedMin = Math.max(0, eMin - pad);
    const paddedMax = eMax + pad;
    setStickyYRange((prev) => {
      if (paddedMin >= prev[0] && paddedMax <= prev[1]) return prev;
      return [Math.min(prev[0], paddedMin), Math.max(prev[1], paddedMax)];
    });
  }, [observedEnvelope]);

  // Pass the sticky range directly to the panels. The smooth transition
  // is handled by `Smile.tsx` via a compositor-only CSS transform on the
  // chart's inner group — when this value changes, Smile applies an
  // initial transform that maps new content to old positions, then
  // transitions to identity over 300 ms on the GPU compositor. Zero
  // React re-renders during the transition; zero main-thread layout
  // work per frame. See `Smile.tsx` for the transform math.
  const smileYRange = stickyYRange;

  // Table sources derive from the already-throttled panel state, so
  // they're 5 Hz too — no separate useThrottled needed. The previous
  // double-throttle ran two extra setIntervals for no benefit.
  const naiveTable = useMemo(
    () => ({
      slice: naivePanelState.latestInputs?.slice,
      params:
        naivePanelState.data?.fitResult.ok === true
          ? naivePanelState.data.fitResult.params
          : undefined,
    }),
    [naivePanelState.latestInputs?.slice, naivePanelState.data],
  );
  const gatedTable = useMemo(
    () => ({
      slice: gatedPanelState.data?.sourceSlice,
      params:
        gatedPanelState.data?.fitResult.ok === true
          ? gatedPanelState.data.fitResult.params
          : undefined,
    }),
    [gatedPanelState.data],
  );

  // Σ|miss| values for the sparkline. Sampled inside MismarkSparkline
  // at its own cadence (500 ms); we just supply the current value each
  // render. Memoised so identity is stable when the underlying data
  // hasn't changed.
  const naiveMissSum = useMemo(
    () => summariseMisses(computeMisses(naiveTable))?.sum,
    [naiveTable],
  );
  const gatedMissSum = useMemo(
    () => summariseMisses(computeMisses(gatedTable))?.sum,
    [gatedTable],
  );

  // Naive surface "torn" fraction — fraction of strikes whose |IV miss|
  // exceeds the demo's torn threshold. Feeds Stage 6's TearStart /
  // TearRecovery sustained-threshold buffers. The threshold is locked at
  // 0.005 IV (50 bps); revisit during playthrough polish if real-time
  // surfaces a tuning concern. Reuses the already-throttled naiveTable,
  // so this updates at the 5 Hz display cadence — same rate as the
  // commentary's OBSERVATION tick.
  const naiveTornFraction = useMemo(() => {
    const rows = computeMisses(naiveTable);
    if (rows.length === 0) return 0;
    const TORN_IV_THRESHOLD = 0.005;
    let torn = 0;
    for (const row of rows) {
      if (row.miss !== undefined && Math.abs(row.miss) > TORN_IV_THRESHOLD) {
        torn += 1;
      }
    }
    return torn / rows.length;
  }, [naiveTable]);

  // Naive's lag — single source of truth in `./metrics.ts`. Used by
  // the event detector to gate TearRecovery: a low `tornFraction`
  // alone is a derived signal that can dip while naive is structurally
  // still skewed, so recovery also requires the structural skew to have
  // actually drained. The helper guarantees this site and the Panel's
  // displayed lag chip compute identical values.
  const naiveLagTicks =
    computeSnapshotLag("naive", {
      latestInputsTickIndex: naivePanelState.latestInputs?.tickIndex,
      dataSourceTickIndex: naivePanelState.data?.sourceTickIndex,
      currentTickIndex: undefined, // unused for naive mode
    }) ?? 0;

  // Commentary orchestrator. Wires CommentaryToastStack + ScenarioSettler
  // + EventDetector + Scheduler behind a single hook. Receives primitives
  // (no object props) so re-renders don't churn snapshot identity. See
  // `demo/src/commentary/use-commentary.ts` module header for the full
  // design contract.
  const commentary = useCommentary({
    shockActive: feed.shocking,
    tickHz: feed.tickRateHz,
    expiries: nExpiriesFitted,
    repairMode,
    tornFraction: naiveTornFraction,
    naiveLagTicks,
    pendingCount: naivePanelState.pendingCount,
    surfaceArbStatus: naivePanelState.data?.surfaceArbStatus ?? "arb-free",
    displayMaturityYears,
    hoveredRegion,
  });

  // Track region-engaged transitions for analytics. Fires only on identity
  // change to a non-null region (X → Y or null → Y); exits (Y → null) are
  // not interesting. Same-value re-renders are filtered by the ref diff.
  const prevCommittedRegionRef = useRef<RegionId | null>(null);
  useEffect(() => {
    const prev = prevCommittedRegionRef.current;
    const curr = commentary.committedRegion;
    if (curr !== null && curr !== prev) {
      trackEvent("region-engaged", { region: curr });
    }
    prevCommittedRegionRef.current = curr;
  }, [commentary.committedRegion]);

  const [viewportFits, setViewportFits] = useState(true);
  useEffect(() => {
    const check = () => {
      setViewportFits(
        window.innerWidth >= MIN_VIEWPORT_WIDTH &&
          window.innerHeight >= MIN_VIEWPORT_HEIGHT,
      );
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // ViewportNotice is rendered as a fixed overlay on top of the demo
  // (rather than as an early-return replacement). Backdrop-blur on the
  // notice itself + a dim layer behind it surface the demo softly
  // through the notice, signalling "this is what you're missing" rather
  // than blanking the page. Compositor-only: alpha composition + CSS
  // `backdrop-filter: blur(...)`.

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-fg">
      {/* Brand bar (~36 px) — project identity. Title, tagline, and the
          source/demo/install/author icon cluster (project-meta, not runtime
          tools — they live here rather than in the toolbar below). */}
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border px-5">
        <div className="flex items-baseline gap-2.5">
          <span className="font-sans text-base font-semibold tracking-tight">
            Oracaus
          </span>
          <span className="whitespace-nowrap font-sans text-[11px] text-fg-muted">
            SVI vol-surface render alignment in React
          </span>
        </div>
        {/* External-link cluster — source → install → why this exists.
            GitHub (technical click-through: "show me the code"), npm
            (install click-through: "give me the library"), LinkedIn
            (architectural click-through: "why does this exist" —
            points at the mini-series capstone article so an
            architecturally-curious demo visitor lands on the
            substantive content first; the author's profile remains
            reachable via the article's byline). All styled as utility
            icons — matched dimensions, identical hover treatment.
            `trackEvent` target stays as `"linkedin"` for analytics
            continuity even though the destination URL is the capstone
            article — historical data isn't fragmented by the
            label-change. */}
        <div className="flex items-center gap-1">
          <a
            href="https://github.com/oracaus/oracaus"
            target="_blank"
            rel="noreferrer"
            title="Oracaus on GitHub"
            aria-label="open the Oracaus repository on GitHub"
            onClick={() => trackEvent("link-clicked", { target: "github" })}
            className="focus-ring flex h-7 w-7 items-center justify-center rounded bg-bg text-fg-muted transition-colors duration-75 hover:text-fg"
          >
            <GithubIcon />
          </a>
          <a
            href="https://www.npmjs.com/package/@oracaus/coherent-derivation"
            target="_blank"
            rel="noreferrer"
            title="@oracaus/coherent-derivation on npm"
            aria-label="open @oracaus/coherent-derivation on npm"
            onClick={() => trackEvent("link-clicked", { target: "npm" })}
            className="focus-ring flex h-7 w-7 items-center justify-center rounded bg-bg text-fg-muted transition-colors duration-75 hover:text-fg"
          >
            <NpmIcon />
          </a>
          <a
            href="https://www.linkedin.com/pulse/anatomy-substrate-substantive-screen-side-derivation-przemys%C5%82aw-ka%C5%82ka-iklae/"
            target="_blank"
            rel="noreferrer"
            title="The Anatomy of the Substrate — mini-series capstone"
            aria-label="open the architectural capstone article on LinkedIn"
            onClick={() => trackEvent("link-clicked", { target: "linkedin" })}
            className="focus-ring flex h-7 w-7 items-center justify-center rounded bg-bg text-fg-muted transition-colors duration-75 hover:text-fg"
          >
            <LinkedInIcon />
          </a>
        </div>
      </header>

      {/* Toolbar (~56 px) — runtime working surface:
            - Live status (left): TICK / SPOT / SEED with label-on-top
              treatment so values are scannable at a glance
            - Controls (right): tick rate, compute, shock, advanced
          Stage 11 region root: `toolbar`. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Stage 11 pointer-aware hover region; keyboard users receive INTRO + scenario + event narration instead — documented limitation. */}
      <div
        data-region="toolbar"
        className="flex h-14 shrink-0 items-stretch bg-bg-elev border-b border-border"
        onMouseEnter={() => enterRegion("toolbar")}
        onMouseLeave={() => leaveRegion("toolbar")}
      >
        <div className="flex items-center gap-2 px-5" aria-live="off">
          <StatusReadout
            label="tick"
            value={String(feed.tick?.tickIndex ?? 0)}
            width="6ch"
          />
          <StatusReadout
            label="spot"
            value={(feed.tick?.spot ?? 100).toFixed(2)}
            width="6ch"
          />
          {sessionFromUrl.recording && (
            <span className="rounded bg-accent-info px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-bg">
              rec
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-4 border-l border-border px-5">
          <Controls
            tickRateHz={feed.tickRateHz}
            setTickRateHz={feed.setTickRateHz}
            nExpiriesFitted={nExpiriesFitted}
            setNExpiriesFitted={setNExpiriesFitted}
            displayMaturityYears={displayMaturityYears}
            setDisplayMaturityYears={setDisplayMaturityYears}
            repairMode={repairMode}
            setRepairMode={setRepairMode}
            onShock={feed.triggerShock}
            shocking={feed.shocking}
            {...(sessionFromUrl.recording
              ? {}
              : {
                  onCommentaryToggleClick: commentary.toggleEnabled,
                  commentaryEnabled: commentary.enabled,
                })}
          />
        </div>
      </div>

      {/* Creator-side advanced controls — out of the toolbar, triggered
          via `?` keyboard shortcut. Modal renders into a portal so it
          sits outside the flex layout regardless of where it lives in
          the tree. */}
      <AdvancedControls
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        seed={seed}
        recording={sessionFromUrl.recording}
        onReseed={setSeed}
      />

      {/* Main grid — left column stacks NAIVE above ORACAUS (shared
          x-axis reads down the column for strike-by-strike comparison);
          right rail stacks the option-chain table and the recent-
          mismark sparkline. The sparkline takes whatever vertical
          space the table doesn't fill, scaling up on tall viewports. */}
      <main className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Stage 11 region root: `naive-panel`. Wraps the smile + chip
              rail + metric ribbon. Inner per-strike hover state
              (`hoveredK`) is independent. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Stage 11 pointer-aware hover region; keyboard users receive INTRO + scenario + event narration instead — documented limitation. */}
          <div
            data-region="naive-panel"
            className="min-h-0 flex-1 border-b border-border"
            onMouseEnter={() => enterRegion("naive-panel")}
            onMouseLeave={() => leaveRegion("naive-panel")}
          >
            <Panel
              title="NAIVE"
              subtitle={`Vol smile @ ${expiryLabel}`}
              mode="naive"
              data={naivePanelState.data}
              latestInputs={naivePanelState.latestInputs}
              isComputing={naivePanelState.isComputing}
              currentTickIndex={naivePanelState.currentTickIndex}
              pendingCount={naivePanelState.pendingCount}
              hoveredK={hoveredK}
              onHoverChange={setHoveredK}
              smileXRange={SMILE_X_RANGE}
              smileYRange={smileYRange}
            />
          </div>
          {/* Stage 11 region root: `gated-panel`. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Stage 11 pointer-aware hover region; keyboard users receive INTRO + scenario + event narration instead — documented limitation. */}
          <div
            data-region="gated-panel"
            className="min-h-0 flex-1"
            onMouseEnter={() => enterRegion("gated-panel")}
            onMouseLeave={() => leaveRegion("gated-panel")}
          >
            <Panel
              title="ORACAUS"
              subtitle={`Vol smile @ ${expiryLabel}`}
              mode="gated"
              data={gatedPanelState.data}
              latestInputs={gatedPanelState.latestInputs}
              isComputing={gatedPanelState.isComputing}
              currentTickIndex={gatedPanelState.currentTickIndex}
              intentChangedKey={gatedPanelState.intentChangedKey}
              hoveredK={hoveredK}
              onHoverChange={setHoveredK}
              smileXRange={SMILE_X_RANGE}
              smileYRange={smileYRange}
            />
          </div>
        </div>

        {/* Metrics rail. Width clamps so charts breathe on small
            viewports and the rail expands on wide displays. Inside:
            - OptionChainTable (shrink-0, all 21 rows visible without
              scroll — natural height)
            - MismarkSparkline (flex-1, fills remaining height) */}
        <aside className="flex min-h-0 w-[clamp(400px,28vw,560px)] shrink-0 flex-col border-l border-border">
          {/* Stage 11 region root: `chain-table`. Wrapper preserves the
              `flex min-h-0 flex-1` sizing the chain table relies on for
              its scrollable rows region. Separate from the sparkline
              below so insights about per-strike comparison vs the
              last-60 s mismark trace can fire distinctly. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Stage 11 pointer-aware hover region; keyboard users receive INTRO + scenario + event narration instead — documented limitation. */}
          <div
            data-region="chain-table"
            className="flex min-h-0 flex-1 flex-col"
            onMouseEnter={() => enterRegion("chain-table")}
            onMouseLeave={() => leaveRegion("chain-table")}
          >
            <OptionChainTable
              naive={naiveTable}
              gated={gatedTable}
              hoveredK={hoveredK}
              onHoverChange={setHoveredK}
            />
          </div>
          {/* Stage 11 region root: `mismark-sparkline`. The sparkline is
              `h-40 shrink-0`; the wrapper passes through naturally. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Stage 11 pointer-aware hover region; keyboard users receive INTRO + scenario + event narration instead — documented limitation. */}
          <div
            data-region="mismark-sparkline"
            onMouseEnter={() => enterRegion("mismark-sparkline")}
            onMouseLeave={() => leaveRegion("mismark-sparkline")}
          >
            <MismarkSparkline naive={naiveMissSum} gated={gatedMissSum} />
          </div>
        </aside>
      </main>

      {/* Top-centred toast stack. Rendered only when commentary is
          enabled AND the advanced-controls modal isn't open. The modal
          covers the top-centre area with its backdrop; unmounting the
          stack while it's open is cleaner than fighting z-index. */}
      {commentary.enabled && !advancedOpen && (
        <CommentaryToastStack toasts={commentary.toasts} />
      )}

      {!viewportFits && <ViewportNotice />}
    </div>
  );
}

// Compact label-on-top status readout for the top bar. Tiny uppercase
// label, monospace value with a fixed-width slot so column alignment
// holds across digit-count changes. Used for tick / spot / seed.
function StatusReadout({
  label,
  value,
  width,
  tone = "fg",
}: {
  label: string;
  value: string;
  width: string;
  tone?: "fg" | "muted";
}) {
  const valueClass = tone === "muted" ? "text-fg-muted" : "text-fg";
  return (
    <div className="flex flex-col items-start leading-none">
      <span className="text-[9px] uppercase tracking-widest text-fg-muted">
        {label}
      </span>
      <span
        className={`mt-1 inline-block font-mono text-sm font-semibold tabular-nums ${valueClass}`}
        style={{ width }}
      >
        {value}
      </span>
    </div>
  );
}

// Below the supported viewport the side-by-side rail collapses and the
// demo's central comparison weakens. Render as a fixed overlay on top
// of the (clipped) running demo: a dim layer plus a backdrop-blurred
// card. Compositor-only — alpha composition + `backdrop-filter: blur`.
// The demo shows through softly behind, so the user sees what they're
// missing while the chart's failure mode and the message coexist on
// screen.
function ViewportNotice() {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="viewport-notice-title"
    >
      <div className="max-w-md rounded border border-border/60 bg-bg-elev/75 p-6 text-center font-sans shadow-2xl backdrop-blur-sm">
        <h1
          id="viewport-notice-title"
          className="mb-3 text-base font-semibold tracking-tight"
        >
          Oracaus · viewport too small
        </h1>
        <p className="mb-2 font-mono text-xs text-fg-muted">
          this demo wants ≥{MIN_VIEWPORT_WIDTH} × {MIN_VIEWPORT_HEIGHT}
        </p>
        <p className="text-sm text-fg-muted">
          The naive-vs-Oracaus comparison reads at a glance only when both
          panels and the option chain are visible together. Resize the window or
          open on a desktop / laptop display.
        </p>
      </div>
    </div>
  );
}
