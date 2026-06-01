# Changelog

All notable changes to `@oracaus/coherent-derivation` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-06-01

Initial release.

### The hook

- `useCoherentDerivation<TStreaming, TIntent, TOutput>(options)` — single hook for snapshot-coherent async derivations against streaming and intent inputs in React.
- Two named input kinds:
  - `streaming` — changes absorb (in-flight completes against its tagged snapshot; next compute kicks off against the latest streaming value at completion).
  - `intent` — changes cancel-and-restart in-flight against the new pair.
  - Mixed UIs declaring both are first-class; the substrate dispatches per input kind automatically.
- Two policy-agnostic guarantees uphold the substrate's invariant (*every emitted frame composes `(input, output)` from the same snapshot*): atomic commit at render (single-object `StrategyState` swap through `useSyncExternalStore` — `data` and `dataSnapshotId` swap as one reference) and identity-based composition (snapshot-ID tagging verified before emit).

### Input shape

- Both `streaming` and `intent` slots accept either a raw value or a `Source<T>` — a subscription-shaped value following React's `useSyncExternalStore` shape. Raw values fit low-rate inputs (sliders, mode toggles); `Source<T>` is the load-bearing shape for high-rate streams (option chains at 50–500 ticks/sec) — the substrate subscribes once and consumes pushes without forcing a host re-render per event.
- `useEventSource(subscribe, initial?)` helper — bridges a subscribe-shaped upstream feed (`subscribe(callback) → unsubscribe`) into a `Source<T>` in one line. The canonical adopter pattern for high-rate streaming inputs.
- `useCallbackSource<T>(initial?)` helper — returns `[Source<T>, push]` for imperative-push flows (event handlers, manual button-click paths, ref-based code).
- `Source<T>` interface + `SourceBrand` symbol + `isSource` type guard exported — adopters with non-imperative upstreams (RxJS observables, Solid signals, MobX reactions, SSE) construct their own `Source<T>` directly against the published interface.

### Worker protocol

- Worker protocol types (`WorkerInbound`, `WorkerOutbound`, `ComputeRequest`, `AbortRequest`, `ResultResponse`, `ErrorResponse`, `WorkerCrashResponse`, `SerializedError`) exported and **semver-stable from v0.5.0** — adopters writing custom workers via `workerFactory` can rely on the message shape across patch and minor releases.
- `SnapshotId` exported — adopters echo the id field on wire messages; the brand prevents direct construction but the type is now nameable in adopter helper signatures.
- Default worker reconstructs `compute` via `new Function(compute.toString())` with a `[native code]` pre-flight check; CSP environments and non-trivial compute use `workerFactory` to supply a bundled worker module.
- `SerializedError` documents `Error.cause` loss across the boundary (ES2022 cause-chaining doesn't survive `structuredClone`; workaround: fold cause details into the thrown error's `message`).

### Distribution

- Library bundle ~3 KB gz total (single shipped file; worker source inlined as a string for Blob-URL spawning). Test budgets enforce <8 KB gz main + <3 KB gz worker source pre-inlining.
- `sideEffects: false` declared — adopter bundlers tree-shake unused exports.
- ESM only; React 18+ peer dependency.
