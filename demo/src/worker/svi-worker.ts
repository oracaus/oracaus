// Custom worker module for the demo. Bundles the SVI fitter and calendar-
// arb repair pass; dispatches the library's inbound `compute` messages
// directly to per-slice `fitSviSlice` + `repairCalendarArb`. This is the
// canonical adopter pattern for non-trivial compute that cannot cross the
// worker boundary as a `new Function(source)` reconstruction.
//
// Wiring: `useCoherentDerivation({ workerFactory: () => new Worker(new URL
// ("./worker/svi-worker.ts", import.meta.url), { type: "module" }), ... })`
// — no `compute` field on the hook call. The runtime path is `inputs →
// postMessage(inbound) → this worker → computeSurface → postMessage(outbound)
// → strategy commit`. `inbound.source` is omitted by the library in this
// shape; this worker has the fitter statically and never needed it.
//
// Input is the full surface (`slices: Slice[]`); output is per-maturity
// (`perMaturity: SlicedFitResult[]`) plus the surface-level arb status.
// Atomic emit covers the whole surface.
//
// Emit policy: per-slice fits emitted unconditionally with the
// `surfaceArbStatus` flag. The panel layer decides what to render —
// `surfaceArbStatus` is for instrumentation, not for suppression. Both
// the naive and Oracaus panels will render arb-violating output if repair
// fails (the substrate's contract is coherence, not arb-correctness).
//
// Error semantics — layered with the library:
//   • Per-compute errors caught by the try/catch below are emitted as
//     `ErrorResponse { type: "error", id, error }`; the strategy preserves
//     last-good `data` and surfaces the error on the hook's `error` field.
//   • Process-terminal errors (uncaught throws in this worker scope, or a
//     `messageerror` from a structured-clone failure) propagate out of this
//     module and fire the Worker's `error` / `messageerror` events on the
//     main side; `WorkerBridge` in the library catches those and synthesises
//     a `WorkerCrashResponse { type: "worker-error" }` for the strategy.
//   • The demo doesn't need to emit `worker-error` itself — the library's
//     bridge handles process-terminal surfacing across both default and
//     custom workers.

import type {
  ErrorResponse,
  ResultResponse,
  SerializedError,
  WorkerInbound,
  WorkerOutbound,
} from "@oracaus/coherent-derivation";

import type { DemoIntent, DemoSurfaceInput } from "../types.js";
import { computeSurface } from "./compute-surface.js";

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    };
  }
  return {
    name: "NonErrorThrown",
    message: typeof error === "string" ? error : JSON.stringify(error),
  };
}

self.addEventListener("message", (event: MessageEvent<WorkerInbound>) => {
  const inbound = event.data;
  if (inbound.type === "compute") {
    let outbound: WorkerOutbound;
    try {
      // Library wraps inputs as `{ streaming, intent }`. Streaming carries
      // the surface input (chain ticks); intent carries user-driven
      // controls (repair-mode toggle). Intent may be undefined for legacy
      // callers / tests pre-intent; `computeSurface` defaults to
      // repair-on in that case.
      const wrapped = inbound.inputs as {
        streaming: DemoSurfaceInput;
        intent: DemoIntent | undefined;
      };
      // User Timing bracket so each fit shows as a labelled "svi-fit" measure
      // on the Worker track of a Performance recording (DevTools emits the
      // trace event when `measure()` is called). Marks and measures are
      // cleared each call so the user-timing buffer — and with it the
      // worker's JS heap — stays flat over a long session; the already-emitted
      // trace event survives the clear.
      performance.mark("svi-fit:start");
      const output = computeSurface(wrapped.streaming, wrapped.intent);
      performance.measure("svi-fit", "svi-fit:start");
      performance.clearMarks("svi-fit:start");
      performance.clearMeasures("svi-fit");
      outbound = {
        type: "result",
        id: inbound.id,
        output,
      } satisfies ResultResponse;
    } catch (e) {
      outbound = {
        type: "error",
        id: inbound.id,
        error: serializeError(e),
      } satisfies ErrorResponse;
    }
    self.postMessage(outbound);
    return;
  }
  if (inbound.type === "abort") {
    // SVI fits are synchronous; the demo doesn't honour aborts mid-fit.
    return;
  }
});
