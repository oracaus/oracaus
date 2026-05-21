// Worker protocol types — semver-stable from v0.5.0. Adopters writing
// custom workers (via `workerFactory`) type their message handlers
// against these; breaking changes to message shape require a major version bump.
//
// `SnapshotId` is included because it's the field type on every wire
// message (`ComputeRequest.id`, `ResultResponse.id`, …). Adopters echo
// values of this type but never construct them; it's exported so they
// can name the type in their own helper signatures.
export type { SnapshotId } from "./internal/snapshot-id.js";
export type {
  AbortRequest,
  ComputeRequest,
  ErrorResponse,
  ResultResponse,
  SerializedError,
  WorkerCrashResponse,
  WorkerInbound,
  WorkerOutbound,
} from "./internal/worker-protocol.js";
export { useCallbackSource, useEventSource } from "./sources.js";
export type {
  CoherentDerivationResult,
  ComputeFn,
  Source,
  UseCoherentDerivation,
  UseCoherentDerivationOptions,
} from "./types.js";
export { isSource, SourceBrand } from "./types.js";
export { useCoherentDerivation } from "./use-coherent-derivation.js";
