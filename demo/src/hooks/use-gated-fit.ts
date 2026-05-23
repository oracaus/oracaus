// ORACAUS panel's fit-state hook. Wraps `useCoherentDerivation` and surfaces
// the worker's bundled surface output so the panel can render
// `(dots, curve)` from a guaranteed-coherent snapshot pair — at the
// surface level, holding across all maturities simultaneously.
//
// Contrast with `useNaiveFit` (the NAIVE panel) — the whole point of the
// demo:
//
//   NAIVE: posts on every tick, tracks `latestInputs` and `data` in
//          independent React-state slots → renderer pairs LATEST inputs
//          with WHATEVER fit landed → tearing.
//   ORACAUS (this hook): the library's strategy holds visible state during
//          in-flight compute and commits `(input, output)` atomically →
//          renderer always sees a same-snapshot pair → coherent.
//
// Same worker, same fits, same compute. Only the synchronisation strategy
// differs.
//
// **Input ingestion via `useEventSource`.** The feed's `subscribeTick`
// (a `subscribe(cb) → unsubscribe` shape) is bridged into a
// `Source<DemoSurfaceInput>` in one library call. The substrate
// subscribes to that source and consumes ticks at the full feed rate
// (50–500 Hz) without forcing a host re-render per tick. Host re-renders
// only happen on substrate commits (worker-compute cadence, ~12 Hz at
// 70 × 200 / 75 ms). This is the load-bearing decoupling that motivated
// the v0.5.0 source-based input API.
//
// The library's `useCoherentDerivation` returns `data` and `dataSnapshotId`
// but doesn't expose the inputs that produced data. Threading source data
// THROUGH the compute (worker echoes per-slice source data in each
// `SlicedFitResult`) is the cleanest way to give the demo's verification
// UI exact pairing — independent of which display maturity the panel
// later projects to.
//
// `data` is a full `DemoSurfaceOutput`. The panel projects to one maturity
// via `displayMaturityIdx` (App-level state).

import {
  useCoherentDerivation,
  useEventSource,
} from "@oracaus/coherent-derivation";
import { useMemo } from "react";
import type {
  DemoIntent,
  DemoSurfaceInput,
  DemoSurfaceOutput,
} from "../types.js";
import type { TickListener } from "./use-feed.js";
import type { SurfaceSnapshot } from "./use-naive-fit.js";

const PLACEHOLDER_TICK_SENTINEL = -1;

export type GatedFitState = {
  /**
   * The library's coherent committed output — the full surface. Each
   * `perMaturity[i]` carries its own `sourceSlice` so per-(display, fit)
   * coherence holds even when the user switches display maturity.
   */
  readonly data: DemoSurfaceOutput | undefined;
  readonly isComputing: boolean;
  /**
   * The library's currently-visible inputs — held during in-flight compute,
   * NOT the latest tick. These are the inputs that produced `data`.
   * Adopter-visible because `useCoherentDerivation` holds visible state
   * during in-flight compute.
   */
  readonly latestInputs: SurfaceSnapshot | undefined;
};

export function useGatedFit(
  intent: DemoIntent,
  workerFactory: () => Worker,
  subscribeTick: (listener: TickListener) => () => void,
): GatedFitState {
  // Bridge the feed's `subscribe(cb) → unsubscribe` shape into a
  // `Source<DemoSurfaceInput>` in one call. The substrate consumes
  // pushes at the full feed rate (50–500 Hz) without forcing a host
  // re-render per tick — re-renders fire only on substrate commits.
  const tickSource = useEventSource<DemoSurfaceInput>(
    (push) =>
      subscribeTick(({ slices, trueParamsPerSlice, tickIndex }) =>
        push({ slices, trueParamsPerSlice, tickIndex }),
      ),
    PLACEHOLDER_INPUTS,
  );

  // Intent carries the user-controlled repair-mode toggle. A change to
  // `intent` is the substrate's cancel-and-restart signal — any in-flight
  // compute is aborted, a fresh compute starts against the new
  // (streaming, intent) pair.
  //
  // `workerFactory` supplies the bundled SVI worker; `compute` is omitted
  // because the SVI fitter is multi-file with module imports and can't cross
  // the boundary as a stringified closure. Output type comes from the
  // explicit generic.
  const result = useCoherentDerivation<
    DemoSurfaceInput,
    DemoIntent,
    DemoSurfaceOutput
  >({
    streaming: tickSource,
    intent,
    workerFactory,
  });

  // Suppress the placeholder result. The worker echoes back the empty
  // placeholder surface with `sourceTickIndex === -1`; rendering that
  // would show empty smiles. We gate on the sentinel so the panel shows
  // "no fit yet" until the first real tick lands.
  const realData =
    result.data !== undefined &&
    result.data.sourceTickIndex !== PLACEHOLDER_TICK_SENTINEL
      ? result.data
      : undefined;

  // Pair the source snapshot from the worker's bundled output. Because
  // the library only commits `data` atomically, this pair is always
  // coherent at the surface level (all maturities reflect the same tick).
  const latestInputs: SurfaceSnapshot | undefined = useMemo(() => {
    if (realData === undefined) return undefined;
    const slices = realData.perMaturity.map((m) => m.sourceSlice);
    const trueParamsPerSlice = realData.perMaturity.map(
      (m) => m.sourceTrueParams,
    );
    return {
      slices,
      trueParamsPerSlice,
      tickIndex: realData.sourceTickIndex,
    };
  }, [realData]);

  return {
    data: realData,
    isComputing: result.isComputing,
    latestInputs,
  };
}

// Used until the feed emits its first tick. Empty surface — the worker
// runs no fits (zero slices) and emits a `arb-free` result with empty
// `perMaturity`. The consumer suppresses this via the tickIndex sentinel.
const PLACEHOLDER_INPUTS: DemoSurfaceInput = {
  slices: [],
  trueParamsPerSlice: [],
  tickIndex: PLACEHOLDER_TICK_SENTINEL,
};
