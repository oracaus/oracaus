// Demo-internal types shared between the worker, panels, and verification
// UI. The worker computes the whole surface per tick (per-slice raw SVI
// fits + calendar-arb repair pass); the library emits atomically at the
// surface level, so coherence holds for the whole surface. Components
// project to the displayed slice via `displayMaturityIdx`.
//
// Three shapes:
//   - `DemoSurfaceInput`  — full-surface input the worker receives
//   - `DemoSurfaceOutput` — full-surface output the worker emits
//   - `DemoComputeOutput` — single-slice projection consumed by `Panel`
//     (produced from the surface output via `projectMaturity`).

import type { FitResult } from "./svi/fitter.js";
import type { SurfaceArbStatus } from "./svi/no-arb.js";
import type { SviParams } from "./svi/params.js";
import type { Slice } from "./svi/svi.js";

/**
 * Intent-input shape for the demo. Wired as the `intent` slot of
 * `useCoherentDerivation` (cancel-and-restart on change). Distinct from the
 * `streaming` chain ticks (absorb on change). Demonstrates the article's
 * "mixed inputs are the common case" claim — chain ticks during a fit
 * absorb; repair-mode toggles cancel any in-flight compute and restart
 * against the newest mode.
 *
 * `repairMode`:
 *   - "on"  (default) — run `repairCalendarArb` post-fits, the
 *     production-realistic pipeline.
 *   - "off" — skip the repair pass; emit per-slice fits as-is. Demo
 *     simplification — see `compute-surface.ts` for the `surfaceArbStatus`
 *     compromise.
 */
export type DemoIntent = {
  readonly repairMode: "on" | "off";
};

export type DemoSurfaceInput = {
  /** Slices for the full surface, ordered by `timeToExpiry`. */
  readonly slices: readonly Slice[];
  /** True per-slice params (verification — hidden from the fitter). */
  readonly trueParamsPerSlice: readonly SviParams[];
  readonly tickIndex: number;
};

export type SlicedFitResult = {
  readonly fitResult: FitResult;
  /** Source slice echoed back for the (dots, curve) coherence pairing. */
  readonly sourceSlice: Slice;
  readonly sourceTrueParams: SviParams;
};

export type DemoSurfaceOutput = {
  /** One entry per input slice, aligned 1:1. */
  readonly perMaturity: readonly SlicedFitResult[];
  /** Calendar-arb repair outcome for the surface (see no-arb.ts). */
  readonly surfaceArbStatus: SurfaceArbStatus;
  readonly sourceTickIndex: number;
  /**
   * Worker-side wall-clock for this tick's compute, in milliseconds —
   * measured from receipt of the `compute` message to just before
   * `postMessage` of the result. Includes per-slice fits + repair pass.
   * Excludes the message-marshalling overhead in either direction.
   * Surfaced so the Panel can display a real-time `compute: NN ms`
   * indicator (gives the viewer direct evidence of the failure mode
   * mechanism, complementing the static bench number).
   */
  readonly computeMs: number;
};

/**
 * Single-slice projection of a `DemoSurfaceOutput`. The shape `Panel` and
 * verification UI consume — one (slice, fitResult) pair plus the source
 * tick index. The surface-level `surfaceArbStatus` is propagated to the
 * projection so the Panel can render the same arb-status indicator
 * regardless of which maturity is displayed (status is a property of the
 * whole surface, not one slice). Produced via `projectMaturity`.
 */
export type DemoComputeOutput = {
  readonly fitResult: FitResult;
  readonly sourceSlice: Slice;
  readonly sourceTrueParams: SviParams;
  readonly sourceTickIndex: number;
  readonly surfaceArbStatus: SurfaceArbStatus;
  /** Surface-level wall-clock compute time for this tick, in ms. */
  readonly computeMs: number;
};

/**
 * Project a full-surface output to the single-slice shape `Panel` reads.
 * Returns `undefined` if the surface is missing or the index is out of
 * range — callers conditionally render in those cases.
 *
 * When the optional `expectedSurfaceSize` is supplied, surfaces whose
 * `perMaturity.length` doesn't match are also rejected. This filters
 * out stale surfaces during the transition window after the user
 * changes the expiry-count selector: the worker's previous output (at
 * the old expiry count) lingers in React state for one tick + the
 * worker drain + the display throttle (~25 – 420 ms), during which the
 * `displayMaturityIdx` already reflects the new ladder. Without this
 * filter, `perMaturity[newIdx]` would pick whichever slice happens to
 * sit at that index in the old surface — typically a very different T
 * — which both renders briefly wrong AND contaminates the sticky-yRange
 * envelope expansion with out-of-domain IVs.
 */
export function projectMaturity(
  surface: DemoSurfaceOutput | undefined,
  maturityIdx: number,
  expectedSurfaceSize?: number,
): DemoComputeOutput | undefined {
  if (surface === undefined) return undefined;
  if (
    expectedSurfaceSize !== undefined &&
    surface.perMaturity.length !== expectedSurfaceSize
  ) {
    return undefined;
  }
  const entry = surface.perMaturity[maturityIdx];
  if (entry === undefined) return undefined;
  return {
    fitResult: entry.fitResult,
    sourceSlice: entry.sourceSlice,
    sourceTrueParams: entry.sourceTrueParams,
    sourceTickIndex: surface.sourceTickIndex,
    surfaceArbStatus: surface.surfaceArbStatus,
    computeMs: surface.computeMs,
  };
}
