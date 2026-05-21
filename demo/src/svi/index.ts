// Demo-internal SVI module. The fitter is the demo's reference compute, not
// a library primitive; the public library remains `useCoherentDerivation`.
// The demo's worker module bundles this fitter as the substrate's compute
// via `workerFactory`.

export {
  type CalendarFloorConstraints,
  type CalendarFloorOptions,
  type FitDiagnostics,
  type FitFailure,
  type FitFailureReason,
  type FitOptions,
  type FitResult,
  type FitSuccess,
  fitSviSlice,
  fitSviSliceWithCalendarFloor,
} from "./fitter.js";
export {
  type InitialGuessFailure,
  type InitialGuessResult,
  type InitialGuessSuccess,
  initialGuess,
} from "./initial-guess.js";
export {
  type RawPartials,
  type ReparamPartials,
  rawPartials,
  reparamPartials,
} from "./jacobian.js";
export {
  type JacobianFn,
  type LmConvergenceReason,
  type LmFailureReason,
  type LmOptions,
  type LmResult,
  levenbergMarquardt,
  type ResidualFn,
} from "./lm-solver.js";
export {
  type ButterflyResult,
  butterflyCheck,
  type CalendarResult,
  calendarCheck,
  gatheralG,
  type RepairResult,
  repairCalendarArb,
  type SurfaceArbStatus,
} from "./no-arb.js";
export {
  levelFloor,
  type RawSviParams,
  type SviParams,
  type ValidationFailure,
  type ValidationFailureReason,
  type ValidationResult,
  type ValidationSuccess,
  validateParams,
} from "./params.js";
export {
  fromReparam,
  invSoftplus,
  type ReparamSviParams,
  sigmoid,
  softplus,
  toReparam,
} from "./reparam.js";
export {
  ivToVariance,
  type Quote,
  type Slice,
  varianceToIv,
  w,
} from "./svi.js";
