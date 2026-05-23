// NAIVE panel's fit-state hook. The contrast with `useCoherentDerivation`
// (the ORACAUS panel) is the whole point of the demo:
//
//   NAIVE (this hook):
//     - Worker present (so adopters' "before" picture isn't obviously
//       worse on a different axis — main-thread compute would conflate
//       compute-offload with render-alignment).
//     - On every input change, post a fresh compute. Track inputs in
//       state independently from the latest fit. The renderer pairs
//       LATEST inputs (current React state) with WHATEVER fit just landed
//       — they can be from different snapshots → tearing.
//
//   ORACAUS (`useCoherentDerivation`):
//     - Same worker; same fits. Library's strategy holds visible state
//       during in-flight compute and emits (input, output) atomically. →
//       renderer pairs the same-snapshot inputs and output → coherent.
//
// Inputs and outputs are the full surface (multi-slice). The hook posts
// the whole surface to the worker per tick; state is held at the surface
// level. The Panel projects to one displayed maturity via
// `displayMaturityIdx` (App-level state).
//
// Two paths, both driven by `subscribeTick`:
//   - Worker post path: fires on every logical tick (preserves "post
//     on every input" semantics at high feed rates without a React
//     render per post).
//   - Display path: writes the latest tick into a ref at full feed
//     rate; a single setInterval flushes ref → React state on the 5 Hz
//     display boundary. The same flush drains `pendingCount`, so the
//     panel's queue badge and `latestInputs` both update on the same
//     200 ms boundary that the rest of the demo's UI is gated to.

import { useEffect, useRef, useState } from "react";

import type { FeedTick } from "../feed.js";
import type { SviParams } from "../svi/params.js";
import type { Slice } from "../svi/svi.js";
import type { DemoIntent, DemoSurfaceOutput } from "../types.js";
import type { TickListener } from "./use-feed.js";

// 5 Hz — matches the demo's display clock (App's `useThrottled` at
// 200 ms, useFeed's React-state flush, the Oracaus panel's substrate
// commit cadence as seen by display). Drives `latestInputs` and
// `pendingCount` flushes from this hook so all naive-panel state
// arrives at App on the same boundary.
const DISPLAY_FLUSH_INTERVAL_MS = 1000 / 5;

// Maximum in-flight queue depth for the naive panel's post-on-every-tick
// path. NAIVE intentionally posts at full feed rate (50–500 Hz) regardless
// of worker drain rate; without a cap the worker's inbound message queue
// grows unboundedly (default 70×200 surface = ~250 KB per message × the
// gap between 50 Hz posted and ~12 Hz drained → ~9 MB/sec accumulated)
// and hits `DataCloneError: out of memory` within ~60 s.
//
// 20 is calibrated against the demo's pedagogy: at default compute (~80 ms)
// it represents ~1.6 s of accumulated work — enough for Form 2's snapshot
// lag to read as "20t" in the metric ribbon (unmissably stale) and for
// the queue chip to display saturation, but capped before OOM. Dropping
// ticks above the cap is itself a production-realistic failure mode —
// real naive systems either drop or block; this demo drops, which the
// queue chip reflects.
//
// Phase 4 / publication: a transferable-buffer worker protocol would
// eliminate the structured-clone cost per send. The cap is still load-
// bearing even with transferables (worker heap also has limits) — the
// production-quality combination is cap + transferables.
const MAX_PENDING_QUEUE = 20;

/**
 * Full-surface snapshot — the multi-slice analogue of the pre-3.5
 * single-slice `FitSnapshot`. The naive panel writes this into React
 * state on the 5 Hz display flush (see hook body below); the Oracaus
 * panel reads the surface-aligned version out of the library's
 * atomic-emit.
 */
export type SurfaceSnapshot = {
  readonly slices: readonly Slice[];
  readonly trueParamsPerSlice: readonly SviParams[];
  readonly tickIndex: number;
};

/**
 * Single-slice projection used by `Panel` and the verification UI.
 * Produced from a `SurfaceSnapshot` by `projectSurfaceSnapshot` (below).
 */
export type FitSnapshot = {
  readonly slice: Slice;
  readonly trueParams: SviParams;
  readonly tickIndex: number;
};

/**
 * Pick a single maturity out of a surface snapshot. Returns `undefined`
 * if the surface is missing or the index is out of range.
 *
 * `expectedSurfaceSize` mirrors `projectMaturity`'s rationale (see
 * `types.ts`): rejects surfaces from a different expiry-count
 * configuration so the brief post-`nExpiriesFitted`-change window
 * doesn't render the wrong slice or pollute the sticky-yRange envelope
 * with the previous ladder's out-of-domain IVs.
 */
export function projectSurfaceSnapshot(
  surface: SurfaceSnapshot | undefined,
  maturityIdx: number,
  expectedSurfaceSize?: number,
): FitSnapshot | undefined {
  if (surface === undefined) return undefined;
  if (
    expectedSurfaceSize !== undefined &&
    surface.slices.length !== expectedSurfaceSize
  ) {
    return undefined;
  }
  const slice = surface.slices[maturityIdx];
  const trueParams = surface.trueParamsPerSlice[maturityIdx];
  if (slice === undefined || trueParams === undefined) return undefined;
  return { slice, trueParams, tickIndex: surface.tickIndex };
}

export type NaiveFitState = {
  readonly data: DemoSurfaceOutput | undefined;
  readonly isComputing: boolean;
  readonly pendingCount: number;
};

export function useNaiveFit(
  intent: DemoIntent,
  workerFactory: () => Worker,
  subscribeTick: (listener: TickListener) => () => void,
): NaiveFitState {
  const [data, setData] = useState<DemoSurfaceOutput | undefined>(undefined);
  const [pendingCount, setPendingCount] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const idRef = useRef(0);
  // Intent (repair-mode toggle) read from a ref so the high-rate
  // post path doesn't need to re-subscribe every time the user
  // changes it. NAIVE has no cancel semantics — in-flight compute
  // completes against whatever intent was current at post time; the
  // next tick posts with the new intent. This is the substrate-less
  // baseline: changing intent here lets old-intent results land
  // before new-intent results, which is part of NAIVE's failure mode.
  const intentRef = useRef<DemoIntent>(intent);
  // Pending-count flush plumbing. The high-rate post path mutates the
  // ref at full feed rate; the 5 Hz interval below flushes to React
  // state only when the value changes. (No companion `latestTickRef` —
  // the naive panel's "latest input view" is now sourced from
  // `feed.tick` in App.tsx, which is the single source of truth for
  // "current displayed tick" across both panels. See
  // DEMO_METRIC_FIX_PLAN.md Phase 2 for the rationale.)
  const pendingCountRef = useRef(0);
  const lastFlushedPendingRef = useRef(0);

  useEffect(() => {
    intentRef.current = intent;
  }, [intent]);

  // Worker setup. Result handler decrements pendingCount via the ref;
  // setData fires at compute-throughput rate which is below the flush
  // rate, so it doesn't bottleneck.
  useEffect(() => {
    workerRef.current = workerFactory();
    const worker = workerRef.current;
    const handler = (event: MessageEvent) => {
      const msg = event.data as
        | { type: "result"; id: string; output: DemoSurfaceOutput }
        | { type: "error"; id: string; error: { message: string } }
        | { type: "worker-error" };
      if (msg.type === "result") {
        // No id-vs-current check: naive accepts ALL results regardless of
        // whether a newer compute has been issued. That's the whole point.
        setData(msg.output);
        pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
      } else if (msg.type === "error" || msg.type === "worker-error") {
        pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
      }
    };
    worker.addEventListener("message", handler);
    return () => {
      worker.removeEventListener("message", handler);
      worker.terminate();
      workerRef.current = null;
    };
  }, [workerFactory]);

  // High-rate post path. Fires on every logical tick from the feed.
  // Builds a slim snapshot of just the fields the worker needs (slices,
  // trueParamsPerSlice, tickIndex) and posts it. The "latest input
  // view" the panel displays is no longer plumbed through this hook —
  // App.tsx derives it from `feed.tick` so the display source is the
  // same across both panels (avoids the antiphased-timer drift fixed
  // in DEMO_METRIC_FIX_PLAN.md Phase 2).
  useEffect(() => {
    const onTick = (tick: FeedTick) => {
      const snapshot: SurfaceSnapshot = {
        slices: tick.slices,
        trueParamsPerSlice: tick.trueParamsPerSlice,
        tickIndex: tick.tickIndex,
      };

      const worker = workerRef.current;
      if (worker === null) return;
      // Queue saturated — drop this tick. Without this guard the worker's
      // inbound message queue grows unboundedly (see MAX_PENDING_QUEUE
      // header comment); with it, the demo's failure mode caps at a
      // visible "queue: 20" / "lag: ~20t" steady state instead of
      // crashing the tab. Dropped ticks ARE part of the naive design's
      // failure-mode narrative — production naive systems either drop
      // or block when the consumer can't keep up.
      if (pendingCountRef.current >= MAX_PENDING_QUEUE) return;
      idRef.current += 1;
      const id = `naive-${idRef.current}`;
      pendingCountRef.current += 1;
      // The worker expects the library's `{ streaming, intent }` envelope
      // around adopter inputs. The naive panel bypasses
      // `useCoherentDerivation` but uses the same worker, so the envelope
      // must match. Mixed-input case: streaming surface + intent
      // (repair-mode toggle). NAIVE reads intent from a ref captured
      // at post time — there's no cancel semantics here, so in-flight
      // compute completes against this intent value regardless of
      // subsequent toggles.
      try {
        worker.postMessage({
          type: "compute",
          id,
          source: "/* ignored by demo worker */",
          inputs: { streaming: snapshot, intent: intentRef.current },
        });
      } catch (err) {
        // Defensive: the queue cap above should prevent the
        // DataCloneError(OOM) that motivated this try/catch, but if the
        // browser still refuses the clone for any reason we don't want
        // a thrown postMessage to crash the tick generator. Decrement
        // the pending count we optimistically incremented above so the
        // queue badge stays honest, and log for diagnostics.
        pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
        console.error("useNaiveFit: postMessage failed", err);
      }
    };
    return subscribeTick(onTick);
  }, [subscribeTick]);

  // 5 Hz flush — pushes pendingCount from ref to React state. Skipping
  // when the value hasn't changed avoids spurious downstream re-renders.
  useEffect(() => {
    const id = setInterval(() => {
      const nextPending = pendingCountRef.current;
      if (nextPending !== lastFlushedPendingRef.current) {
        lastFlushedPendingRef.current = nextPending;
        setPendingCount(nextPending);
      }
    }, DISPLAY_FLUSH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return {
    data,
    isComputing: pendingCount > 0,
    pendingCount,
  };
}
