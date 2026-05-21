// Wire protocol between the main thread and the library's Web Worker.
//
// **Semver-stable from v0.5.0.** These types are re-exported from
// `@oracaus/coherent-derivation` so adopters writing custom workers
// (via `workerFactory`) type their message handlers against them. Breaking
// changes to the shape of any message (renamed/removed/retyped field) or
// the discriminant set require a major-version bump.

import type { SnapshotId } from "./snapshot-id.js";

// ─── Inbound (main → worker) ─────────────────────────────────────────────────

/**
 * Request the worker compute `output = source(inputs)` against the supplied
 * `inputs`, tagging the result with `id` on response.
 */
export interface ComputeRequest {
  readonly type: "compute";
  /**
   * Monotonic per-strategy tag. The worker echoes this verbatim on the
   * corresponding `ResultResponse` / `ErrorResponse` so the main side can
   * correlate the response against `currentSnapshotId` and drop stale
   * responses whose snapshot has been superseded.
   */
  readonly id: SnapshotId;
  /**
   * The compute payload. The library wraps the user's split `streaming`
   * and `intent` inputs into a single `{ streaming, intent }` object
   * before posting, so consumer-side compute functions destructure the
   * two kinds explicitly. Type-erased on the wire; the hook reattaches
   * `TStreaming` / `TIntent` typing.
   */
  readonly inputs: unknown;
  /**
   * Serialised source of the user's `compute` function (`fn.toString()`),
   * present when the hook was called with a `compute` option. The library's
   * inlined worker reconstructs an executable function via
   * `new Function(...)` — so when present the compute must be pure (no
   * closures over caller-scope), per the locked API contract.
   *
   * Omitted when the hook was called with `workerFactory` and no `compute`
   * (bundled-worker pattern): the worker has the compute statically; nothing
   * needs to cross the boundary as a string. Custom workers that don't use
   * `source` may ignore the field entirely.
   *
   * CSP environments that disallow the `Function` constructor cannot use the
   * default worker; supply a `workerFactory` with the compute statically
   * embedded (see the demo's `svi-worker.ts` for the pattern).
   */
  readonly source?: string;
}

/**
 * Abort the in-flight compute identified by `id`. The worker flips its
 * `AbortController.signal.aborted` to `true`; cooperative computes observe
 * the signal and reject early. No response is sent for an aborted request
 * (any pending result is dropped on the main side via id mismatch in any
 * case — abort is best-effort early termination, not a correctness
 * dependency).
 */
export interface AbortRequest {
  readonly type: "abort";
  /** The id of the compute to abort. */
  readonly id: SnapshotId;
}

/** Discriminated union of main → worker messages. */
export type WorkerInbound = ComputeRequest | AbortRequest;

// ─── Outbound (worker → main) ────────────────────────────────────────────────

/**
 * Successful compute output for the request tagged with `id`. The main-side
 * strategy commits `(output, id)` atomically — adopters never see a frame
 * where `data` and `dataSnapshotId` come from different snapshots.
 */
export interface ResultResponse {
  readonly type: "result";
  /** Echo of `ComputeRequest.id` — load-bearing for stale-response detection. */
  readonly id: SnapshotId;
  /** Whatever the consumer's `compute` function returned. Type-erased on the wire. */
  readonly output: unknown;
}

/**
 * Compute threw or rejected for the request tagged with `id`. Last-good
 * `data` and `dataSnapshotId` are preserved by the strategy; `error` is
 * surfaced via the hook's `error` field. Recoverable — the next compute
 * clears it.
 */
export interface ErrorResponse {
  readonly type: "error";
  /** Echo of `ComputeRequest.id`. */
  readonly id: SnapshotId;
  /** Serialised payload reconstructed by the main side via `deserializeError`. */
  readonly error: SerializedError;
}

/**
 * Catastrophic worker-level failure (uncaught error in the worker scope or a
 * `messageerror` event from a structured-clone failure). Distinct from
 * `ErrorResponse` because there is no `SnapshotId` to correlate against —
 * the worker process is dead, so the strategy treats this as terminal:
 * any in-flight compute fails; subsequent `setInputs` calls are no-ops
 * (the consumer must destroy and remount to recover).
 */
export interface WorkerCrashResponse {
  readonly type: "worker-error";
  /**
   * Serialised payload. Synthesised on the main side by `WorkerBridge` from
   * the worker's `error` (`name: "WorkerError"`) or `messageerror`
   * (`name: "WorkerMessageError"`) events.
   */
  readonly error: SerializedError;
}

/**
 * Discriminated union of worker → main messages. `ResultResponse` /
 * `ErrorResponse` are per-compute; `WorkerCrashResponse` is process-terminal.
 */
export type WorkerOutbound =
  | ResultResponse
  | ErrorResponse
  | WorkerCrashResponse;

// ─── Error payload ───────────────────────────────────────────────────────────

/**
 * Native `Error` survives `structuredClone` for `name` / `message` / `stack`
 * but loses its prototype chain. Custom error subclasses become base `Error`
 * across the boundary. Adopters needing the original prototype identity
 * should branch on `name` rather than `instanceof`.
 *
 * **`Error.cause` is not preserved.** ES2022 `Error.cause` carries a nested
 * error for error-chaining; this payload doesn't serialise it. If your
 * compute throws errors with a `cause`, the cause's information doesn't
 * cross the worker boundary in the current protocol. Workaround: include
 * cause details in the thrown error's `message` string. Versioned change
 * to add `cause` is a candidate for a future minor.
 */
export interface SerializedError {
  /** Lifted from `Error.name`. Use this to branch instead of `instanceof`. */
  readonly name: string;
  /** Lifted from `Error.message`. */
  readonly message: string;
  /** Lifted from `Error.stack` when available; engine-dependent format. */
  readonly stack?: string;
}
