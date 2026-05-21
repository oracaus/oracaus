// Per-panel lag formulas — single source of truth for the demo's
// "displacement between displayed input and displayed fit" metric.
//
// Lives outside Panel.tsx so the formulas are unit-testable without
// React. Panel.tsx and App.tsx (the event detector path) both delegate
// here; any future site that needs to compute lag for either mode
// should also delegate, not duplicate the math.
//
// Two formulas because the panels have different coherence guarantees:
//
//   NAIVE  — displayed (dots, curve) pair lives in independent state
//            slots; they can come from different ticks. The chip's
//            lag NUMBER reports the absolute structural gap — both
//            directions matter because data can be either ahead of
//            or behind the displayed input view depending on the
//            load regime:
//
//              - heavy load: queue saturates → data lags input
//              - light load: eager setData + throttled feed.tick →
//                data runs ahead of input
//
//            mismark and red-dot diagnostics derive from the same
//            (latestInputs, data) pair, so the lag-number-magnitude
//            matches what the chart shows by construction.
//
//   GATED  — substrate's atomic commit guarantees sourceSlice and
//            fitResult.params come from the same tick. The lag chip
//            reports staleness of that coherent snapshot relative to
//            feed.tick's latest tick: max(0, ...) because the substrate
//            cannot commit a fit ahead of its own source tick.

export type LagInputs = {
  readonly latestInputsTickIndex: number | undefined;
  readonly dataSourceTickIndex: number | undefined;
  readonly currentTickIndex: number | undefined;
};

export function computeSnapshotLag(
  mode: "naive" | "gated",
  inputs: LagInputs,
): number | undefined {
  const { latestInputsTickIndex, dataSourceTickIndex, currentTickIndex } =
    inputs;
  if (dataSourceTickIndex === undefined) return undefined;
  switch (mode) {
    case "naive":
      if (latestInputsTickIndex === undefined) return undefined;
      return Math.abs(latestInputsTickIndex - dataSourceTickIndex);
    case "gated":
      if (currentTickIndex === undefined) return undefined;
      return Math.max(0, currentTickIndex - dataSourceTickIndex);
    default:
      return assertNever(mode);
  }
}

// Local helper — matches the pattern in `commentary/phase-reducer.ts`.
// If a future panel mode is added (the deliberately-omitted "always-
// latest" being the obvious candidate), the switch above will type-
// error here, forcing a deliberate decision about which lag semantics
// apply — not a silent fall-through into the gated branch.
function assertNever(value: never): never {
  throw new Error(`computeSnapshotLag: unhandled panel mode: ${String(value)}`);
}
