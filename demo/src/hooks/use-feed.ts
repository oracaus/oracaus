// React hook wrapping `SyntheticFeed`. The feed steps at the configured
// logical tick rate (50–500 Hz); the React-visible `tick` state is
// flushed at a fixed 5 Hz boundary so renders stay capped at the
// display-throttle cadence regardless of how fast the feed runs.
//
// Two consumer paths:
//
//   - `tick` (React state) — updated at most once per 200 ms flush
//     boundary with the latest tick. Used by App.tsx for the top-bar
//     status readouts (`tick #N`, `spot`) and any consumer that only
//     needs display-rate freshness.
//
//   - `subscribeTick(cb)` — fires for every logical tick at full rate.
//     Used by both the naive panel (post-on-every-input to its worker)
//     and the gated panel (via `useEventSource` into the substrate)
//     without paying for a React render per tick.
//
// Without the flush boundary, 500 Hz × full-tree reconciles (two
// charts + 21-row table) saturated the main thread on the development
// machine and dropped frames continuously.

import { useCallback, useEffect, useRef, useState } from "react";

import { type FeedTick, SyntheticFeed } from "../feed.js";

// Cap the React-visible tick refresh rate at 5 Hz — the display-throttle
// cadence real trading desks settle on (see CLAUDE.md §The three rates).
// All Panel / OptionChainTable / MismarkSparkline state is gated to this
// boundary so every paint is internally coherent (no element updates
// before the others). Higher rates produced visible asynchrony between
// chart dots and stats numbers — the chart at 30 Hz felt "ahead" of the
// 5 Hz-throttled stats ribbon below it, reading as flicker.
const REACT_FLUSH_HZ = 5;
const REACT_FLUSH_INTERVAL_MS = 1000 / REACT_FLUSH_HZ;

export type TickListener = (tick: FeedTick) => void;

export type FeedControls = {
  /** Latest tick, refreshed on the 5 Hz React-state flush boundary. */
  readonly tick: FeedTick | undefined;
  readonly tickRateHz: number;
  readonly setTickRateHz: (value: number) => void;
  readonly triggerShock: () => void;
  readonly shocking: boolean;
  /**
   * Subscribe to every logical tick at full feed rate (no flush
   * boundary). Returns an unsubscribe function. Listener identity is
   * held in a stable Set across renders; the subscribe function itself
   * is stable so effect deps don't churn.
   */
  readonly subscribeTick: (listener: TickListener) => () => void;
};

const SHOCK_BURST_MS = 10_000;
const SHOCK_MULTIPLIER = 5;

export type UseFeedOptions = {
  readonly seed: number;
  readonly initialTickRateHz: number;
  /** Number of expiries in the surface. Defaults to the feed's own default (70). */
  readonly nExpiriesFitted?: number;
  /** Strikes per slice. Defaults to the feed's own default (200). */
  readonly nStrikesPerSlice?: number;
};

export function useFeed(options: UseFeedOptions): FeedControls {
  const [tick, setTick] = useState<FeedTick | undefined>(undefined);
  const [tickRateHz, setTickRateHz] = useState(options.initialTickRateHz);
  const [shocking, setShocking] = useState(false);

  const feedRef = useRef<SyntheticFeed | null>(null);
  if (feedRef.current === null) {
    feedRef.current = new SyntheticFeed({
      seed: options.seed,
      ...(options.nExpiriesFitted !== undefined
        ? { nExpiriesFitted: options.nExpiriesFitted }
        : {}),
      ...(options.nStrikesPerSlice !== undefined
        ? { nStrikesPerSlice: options.nStrikesPerSlice }
        : {}),
    });
  }

  // Latest logical tick is buffered in a ref. A separate setInterval
  // (decoupled from the tick generator) flushes ref → React state at
  // REACT_FLUSH_HZ. `lastFlushedTickRef` short-circuits the flush when
  // no new tick has arrived since the previous flush.
  const latestTickRef = useRef<FeedTick | undefined>(undefined);
  const lastFlushedTickRef = useRef<FeedTick | undefined>(undefined);

  // High-rate listeners. Created once, mutated in place — we never
  // need a new Set identity. Set iteration is insertion-order safe.
  const listenersRef = useRef<Set<TickListener>>(new Set());

  // `nExpiriesFitted` is intentionally not a dep of the reseed effect
  // below — we want changes to it to update the ladder in place via
  // `setMaturityCount` (preserving OU state), not to reset the feed.
  // But when reseed DOES fire (seed change, strikes-count change), we
  // want to construct with the CURRENT expiry count. Reading via ref
  // gives us "latest value, no re-subscription".
  const nExpiriesFittedRef = useRef(options.nExpiriesFitted);
  nExpiriesFittedRef.current = options.nExpiriesFitted;

  // Reseed: replace the feed and reset coalescer state. Triggered by
  // explicit reseed actions (the AdvancedControls modal) and by changes
  // to `nStrikesPerSlice` — the latter affects noise-pool indexing
  // structure and the strike grid, which can't be hot-swapped without
  // a fresh feed.
  useEffect(() => {
    const currentNExpiries = nExpiriesFittedRef.current;
    feedRef.current = new SyntheticFeed({
      seed: options.seed,
      ...(currentNExpiries !== undefined
        ? { nExpiriesFitted: currentNExpiries }
        : {}),
      ...(options.nStrikesPerSlice !== undefined
        ? { nStrikesPerSlice: options.nStrikesPerSlice }
        : {}),
    });
    latestTickRef.current = undefined;
    lastFlushedTickRef.current = undefined;
    setTick(undefined);
  }, [options.seed, options.nStrikesPerSlice]);

  // Maturity-ladder update in place. The expiry-count selector is a
  // display-granularity choice, not a "different market" choice — the
  // OU walk on global SVI params, the spot path, the tick index, and
  // the noise pool should all continue across changes to this dim. The
  // alternative (reconstructing the feed) snaps params back to anchor
  // every time the user clicks a different count, which the visitor
  // reads as a discontinuity. See `SyntheticFeed.setMaturityCount` for
  // what's preserved vs replaced.
  useEffect(() => {
    if (options.nExpiriesFitted === undefined) return;
    feedRef.current?.setMaturityCount(options.nExpiriesFitted);
  }, [options.nExpiriesFitted]);

  // Tick generator. Steps the feed at the logical rate; writes the
  // result to `latestTickRef` and synchronously notifies high-rate
  // subscribers. Does NOT touch React state — the flush effect below
  // handles that on its own (slower) cadence.
  useEffect(() => {
    const intervalMs = 1000 / Math.max(1, tickRateHz);
    const id = setInterval(() => {
      const f = feedRef.current;
      if (f === null) return;
      const next = f.step();
      latestTickRef.current = next;
      // Iterate a snapshot — a listener that unsubscribes itself mid-
      // fire is safe (same idiom as the library's strategy notify path).
      // Each invocation is try/caught so one failing listener (e.g. a
      // panel hitting a postMessage error) doesn't propagate up and
      // halt the tick generator, leaving the other panels stranded.
      for (const listener of [...listenersRef.current]) {
        try {
          listener(next);
        } catch (err) {
          console.error("useFeed: tick listener threw", err);
        }
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [tickRateHz]);

  // React-state flush. Independent of the tick generator: runs at a
  // fixed cadence (REACT_FLUSH_HZ) and pushes the latest tick to React
  // when it has changed. This caps full-tree reconciliations regardless
  // of feed rate; without it, the rAF path still rendered at min(feed,
  // 60) Hz, and per-render cost (~400 SVG nodes plus 147 table cells
  // each with SVI evals) saturated the main thread at 50 Hz feed.
  useEffect(() => {
    const id = setInterval(() => {
      const next = latestTickRef.current;
      if (next === undefined || next === lastFlushedTickRef.current) return;
      lastFlushedTickRef.current = next;
      setTick(next);
    }, REACT_FLUSH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const subscribeTick = useCallback((listener: TickListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  // `useCallback` so consumers (Controls' memoised export) see a stable
  // reference across re-renders — otherwise a new function identity at
  // every App render breaks Controls' memoisation and makes the whole
  // toolbar re-reconcile at App's render cadence (50 Hz with the
  // default feed tick rate, up to 500 Hz on the highest setting).
  const triggerShock = useCallback(() => {
    const feed = feedRef.current;
    if (feed === null || shocking) return;
    setShocking(true);
    feed.setShockMultiplier(SHOCK_MULTIPLIER);
    window.setTimeout(() => {
      const f = feedRef.current;
      if (f !== null) f.setShockMultiplier(1);
      setShocking(false);
    }, SHOCK_BURST_MS);
  }, [shocking]);

  return {
    tick,
    tickRateHz,
    setTickRateHz,
    triggerShock,
    shocking,
    subscribeTick,
  };
}
