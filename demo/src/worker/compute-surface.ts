// Pure surface compute: per-slice raw-SVI fits + calendar-arb repair +
// per-maturity assembly + compute timing. Extracted from `svi-worker.ts`
// so the test suite can import it without triggering the worker's
// top-level `self.addEventListener` side effects.
//
// `computeMs` covers everything the worker does on a tick (fits + repair),
// so the Panel's displayed value is the true per-tick worker latency the
// viewer would experience.

import { type FitResult, fitSviSlice } from "../svi/fitter.js";
import {
  butterflyCheck,
  calendarCheck,
  repairCalendarArb,
  type SurfaceArbStatus,
} from "../svi/no-arb.js";
import type { SviParams } from "../svi/params.js";
import type {
  DemoIntent,
  DemoSurfaceInput,
  DemoSurfaceOutput,
  SlicedFitResult,
} from "../types.js";

// Default intent when the caller doesn't supply one (legacy callers,
// tests written pre-intent). Matches the demo's pre-intent behaviour:
// repair pass on, production-realistic.
const DEFAULT_INTENT: DemoIntent = { repairMode: "on" };

// k-grid used for calendar-arb detection + repair verification. 200 points
// matches the bench file's K_GRID and is plenty to catch sub-grid
// violations for smooth SVI surfaces.
export const REPAIR_K_GRID: readonly number[] = Array.from(
  { length: 200 },
  (_, i) => -1.0 + (2.0 * i) / 199,
);

export function computeSurface(
  inputs: DemoSurfaceInput,
  intent: DemoIntent = DEFAULT_INTENT,
): DemoSurfaceOutput {
  const computeStart = performance.now();
  const fitResults = inputs.slices.map((s) => fitSviSlice(s));
  // Branch on intent.repairMode. "on" runs the full repair pipeline
  // (detect + iterate); "off" skips the repair call but still runs the
  // detection passes (butterfly per slice + calendar across slices) so
  // the `surfaceArbStatus` chip reports honestly whether the unrepaired
  // surface has violations. The user chose to skip repair — they should
  // see whether that choice produced a non-arb-free surface, not a
  // hardcoded "arb-free" lie.
  const repair =
    intent.repairMode === "on"
      ? repairCalendarArb(inputs.slices, fitResults, REPAIR_K_GRID)
      : undefined;
  const finalFits = repair?.fitResults ?? fitResults;
  const surfaceArbStatus: SurfaceArbStatus =
    repair?.surfaceArbStatus ??
    checkSurfaceArbStatus(inputs.slices, fitResults);
  const perMaturity: SlicedFitResult[] = inputs.slices.map((slice, i) => {
    const trueParams = inputs.trueParamsPerSlice[i];
    const fit = finalFits[i];
    if (trueParams === undefined || fit === undefined) {
      throw new Error(
        `computeSurface: missing trueParams or fitResult at index ${i}`,
      );
    }
    return {
      fitResult: fit,
      sourceSlice: slice,
      sourceTrueParams: trueParams,
    };
  });
  const computeMs = performance.now() - computeStart;
  return {
    perMaturity,
    surfaceArbStatus,
    sourceTickIndex: inputs.tickIndex,
    computeMs,
  };
}

// Detection-only pass used when repair is off. Reports `arb-free` if the
// raw fits are clean across both butterfly (per-slice) and calendar
// (across slices); `arb-violation` if any check fires. The expensive
// repair iteration is skipped — only the check cost.
function checkSurfaceArbStatus(
  slices: DemoSurfaceInput["slices"],
  fitResults: readonly FitResult[],
): SurfaceArbStatus {
  for (const fit of fitResults) {
    if (!fit.ok) continue;
    const result = butterflyCheck(fit.params, REPAIR_K_GRID);
    if (result.violationCount > 0) return "arb-violation";
  }
  const calendarSlices: Array<{ params: SviParams; timeToExpiry: number }> = [];
  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    const fit = fitResults[i];
    if (slice === undefined || fit === undefined || !fit.ok) continue;
    calendarSlices.push({
      params: fit.params,
      timeToExpiry: slice.timeToExpiry,
    });
  }
  if (calendarSlices.length >= 2) {
    const result = calendarCheck(calendarSlices, REPAIR_K_GRID);
    if (!result.arbitrageFree) return "arb-violation";
  }
  return "arb-free";
}
