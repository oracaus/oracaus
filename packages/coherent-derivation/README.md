# @oracaus/coherent-derivation

**What it does.** Heavy compute that can't fit in a render frame — a vol-surface fit, an ML inference pass, a scenario revaluation — runs async in a Web Worker to keep the main thread responsive. If streaming inputs mutate during the in-flight window, the rendered frame can compose output computed against one snapshot alongside live input values from a newer snapshot — a tuple that never existed upstream. This hook keeps `(input, output)` pairs coherent: visible state holds until in-flight compute completes, then commits both atomically. Screen advances at compute cadence — slightly delayed, never mismatched.

**Live demo:** [demo.oracaus.dev](https://demo.oracaus.dev) — the hero scenario is an SVI vol-surface fit against a synthetic option chain (50–500 ticks/sec), side-by-side panels showing the failure mode without the library and the substrate's atomic-commit fix; trigger the vol-shock burst to see the visible tearing. The underlying coherence problem is domain-agnostic; this happens to be a visceral example. The 70-expiry × 200-strike default is a deliberate stress-test scale — real markets are sparser (~5–10 expiries × 10–30 strikes); the surface-size selector dials down to realistic counts.

## Minimal example

```ts
import { useCoherentDerivation } from "@oracaus/coherent-derivation";

function VolSurfacePanel({ chain }: { chain: OptionChain }) {
  const { data, isComputing } = useCoherentDerivation({
    streaming: { chain },
    compute: async ({ streaming }, signal) =>
      fitVolSurface(streaming.chain, signal),
  });

  if (data === undefined) return <Spinner />;
  return <Smile params={data} />;
}
```

The `compute` function runs in a Web Worker (the library inlines and spawns one). `data` is `undefined` until the first compute completes; after that it's atomically paired with the chain snapshot it was computed against — so rendering against the latest `data` never tears against newer `chain` ticks arriving from upstream.

**Common questions:**

- *Where does the streaming input come from?* Anywhere subscribe-shaped: WebSocket (wrapped), SSE, polling, your existing event bus. The library doesn't transport data — you bring the stream; the substrate aligns it at the React render-commit boundary.
- *What's the trade-off?* Slightly delayed frames vs. mismatched frames. Coherence against slight delay, not coherence against nothing.

**Quick reference** — [Install](#install) · [Two input kinds](#two-input-kinds) · [High-rate streaming inputs](#high-rate-streaming-inputs) · [Custom workers](#custom-workers-for-non-trivial-compute) · [How this compares to ...](#how-this-compares-to) · [Performance](#performance) · [Limitations](#limitations) · [API](#api)

ESM only · React 18+ peer · Chrome 80+ / Firefox 114+ / Safari 15+ · `<` 8 KB gz main + `<` 3 KB gz worker · Worker protocol semver-stable from v0.5.0

## Install

```bash
npm install @oracaus/coherent-derivation
```

ESM only. Requires React 18 or newer.

## Two input kinds

The hook splits inputs into two named slots — `streaming` and `intent` — and treats changes to each differently.

**Streaming inputs** are upstream-cadence values where each new value is "more of the same": option-chain ticks, position updates, market-data feeds. A change does not cancel the in-flight compute — the compute completes against its tagged snapshot, and the next compute kicks off against whichever streaming value is current at completion. Intermediate values that arrived during the in-flight are skipped on screen. The screen advances at compute cadence; the rendered frame never tears.

**Intent inputs** are user-driven values whose new value supersedes the older one: slider drags, parameter tweaks, mode selections. A change cancels the in-flight worker and restarts compute against the new pair. Visible state holds the previous coherent tuple until the restarted compute lands.

**Mixed UIs are first-class.** A vol-surface fitter against a streaming chain AND user-controlled smoothing weights declares both:

```ts
const { data, isComputing } = useCoherentDerivation({
  streaming: { chain },
  intent: { smoothing, fitMode },
  compute: async ({ streaming, intent }, signal) =>
    fitVolSurface(streaming.chain, intent.smoothing, intent.fitMode, signal),
});
```

Chain ticks absorb; smoothing-weight drags cancel-and-restart. No per-hook strategy choice; the *substrate* — the library's internal runtime that holds visible state during in-flight compute and commits `(input, output)` atomically — dispatches per input kind automatically. (We use "substrate" rather than "the library" wherever the distinction matters: the substrate is the runtime contract; `useCoherentDerivation` is your interface to it.)

A deliberately-omitted third option — "always-latest, no gate" — would defeat the substrate's purpose. If you don't need coherence, you don't need this hook.

## High-rate streaming inputs

If your input is a static value or sits in React state at a low rate (sliders, mode toggles), pass it directly. The hook auto-wraps it into a synthetic source internally:

```ts
useCoherentDerivation({ streaming: chain, intent: mode, ... });
```

**For high-rate subscribe-shaped feeds** — option chains at 50–500 ticks/sec, position updates, sensor streams, anything with a `subscribe(callback) → unsubscribe` shape — use **`useEventSource`**. One line, no `useEffect` boilerplate, no React state churn:

```ts
import {
  useCoherentDerivation,
  useEventSource,
} from "@oracaus/coherent-derivation";

function VolSurfacePanel({ subscribeToChain }) {
  const chainSource = useEventSource(subscribeToChain);

  const { data, isComputing } = useCoherentDerivation({
    streaming: chainSource,
    compute: async ({ streaming }, signal) => fitVolSurface(streaming, signal),
  });
  // ...
}
```

The substrate subscribes once and consumes pushes through that subscription — **the host component does not re-render per push.** That is the load-bearing decoupling: at upstream cadence (say 500 ticks per second), the host renders at substrate commit cadence (say 12 Hz at a 70-expiry × 200-strike SVI surface fit), not at input rate.

This matters because the alternative — a `useState` + `useEffect` bridge into the value slot — forces a host re-render per push, which pre-coalesces the stream before the substrate sees it. The substrate's conflate-on-streaming policy can't engage against inputs that have already been throttled below the rate at which it would actually fire.

### Other source patterns

- **Imperative push** (event handlers, manual button-click flows): use `useCallbackSource` — returns `[Source<T>, push]`; call `push(value)` from any context.

- **RxJS / Solid / MobX / SSE upstreams**: construct a `Source<T>` directly. The interface mirrors React's `useSyncExternalStore`; the `SourceBrand` symbol is exported so adopters can attach it.

```ts
import { type Source, SourceBrand } from "@oracaus/coherent-derivation";

function fromObservable<T>(obs$: Observable<T>, getCurrent: () => T): Source<T> {
  return {
    [SourceBrand]: true,
    subscribe: (listener) => {
      const sub = obs$.subscribe(listener);
      return () => sub.unsubscribe();
    },
    getSnapshot: getCurrent,
  };
}
```

## The substrate's invariant

Every emitted frame composes `(input, output)` from the same snapshot. Output computed against snapshot N never paints alongside `streaming` or `intent` inputs from snapshot N+k. The frame either reflects a state that did exist upstream, or it doesn't paint at all.

Two policy-agnostic guarantees uphold the invariant:

- **Atomic commit at render.** The emit happens in a single transition between snapshot arrival and paint commit, microtask-batched. Half-painted intermediates between data-ready and paint never become observable.
- **Identity-based composition.** Every value participating in derivation identity carries the snapshot tag it derives from; the substrate verifies tags match before emit.

Both guarantees hold independently of which input kind changes during in-flight compute.

## Custom workers for non-trivial compute

The default worker reconstructs your `compute` function via `new Function(compute.toString())`. This works for self-contained computes — they can import from module-level scope (lodash, internal pure helpers, type-only imports), but they cannot close over component state, hook results, or runtime-loaded modules.

For substantive compute that's too large to cross as a stringified closure (SVI fitters with their own Jacobian + LM solver + no-arb gates; factor decomposition pipelines; ML inference runtimes), supply a `workerFactory` and **omit `compute` entirely**. The worker bundles its compute statically and dispatches against `WorkerInbound` messages directly:

```ts
// my-compute.worker.ts
import type {
  WorkerInbound,
  WorkerOutbound,
} from "@oracaus/coherent-derivation";
import { runMyCompute, type MyStreaming, type MyIntent } from "./my-compute";

self.addEventListener("message", async (event: MessageEvent<WorkerInbound>) => {
  const message = event.data;
  if (message.type === "abort") return; // honour aborts as needed
  if (message.type !== "compute") return;

  // The library wraps adopter inputs as `{ streaming, intent }`. Destructure
  // explicitly so the per-slot types are visible at the call site. (The
  // streaming/intent split is the hook's; the worker doesn't dispatch on
  // it — it just receives the envelope and unpacks.)
  const { streaming, intent } = message.inputs as {
    streaming: MyStreaming;
    intent: MyIntent;
  };

  try {
    const output = await runMyCompute(streaming, intent);
    self.postMessage({
      type: "result",
      id: message.id,
      output,
    } satisfies WorkerOutbound);
  } catch (err) {
    self.postMessage({
      type: "error",
      id: message.id,
      error: {
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      },
    } satisfies WorkerOutbound);
  }
});
```

```ts
// my-component.tsx
import { useCoherentDerivation } from "@oracaus/coherent-derivation";
import MyWorker from "./my-compute.worker?worker"; // Vite syntax

function MyPanel() {
  // Generics carry the input/output types since `compute` is omitted.
  const { data } = useCoherentDerivation<MyInputs, undefined, MyOutput>({
    streaming: {
      /* ... */
    },
    workerFactory: () => new MyWorker(),
  });
  // ...
}
```

The hook's options shape is a discriminated union: either provide `compute` (inline) or `workerFactory` (bundled), not neither. Both branches accept an optional `workerFactory` override on the inline path (e.g. for warm-start or non-Vite bundlers); the bundled path omits `compute` because the function never crosses the worker boundary.

The `WorkerInbound` / `WorkerOutbound` types are exported from the library and are **semver-stable from v0.5.0** — adopters' custom workers can rely on the message shape across patch and minor releases. Breaking changes to message shape require a major version bump. Note: `ComputeRequest.source` is **optional** (`source?: string`) — present in the inline-compute path, absent in the bundled-worker path; custom workers can ignore the field entirely.

The demo's [`svi-worker.ts`](https://github.com/oracaus/oracaus/blob/master/demo/src/worker/svi-worker.ts) is the reference recipe — a complete worker bundling a substantial SVI fitting pipeline.

## How this compares to ...

### `useDeferredValue` / `useTransition` / `Suspense`

React's concurrent features address **main-thread interruption** — they let React yield to higher-priority work mid-render, splitting long synchronous work into chunks. They operate at the React scheduler level.

This library addresses a different problem: **alignment at render-commit between async compute and the inputs it was computed against**. The compute runs in a Web Worker (off the main thread entirely); the library ensures the worker's result composes coherently with the input snapshot that triggered it, regardless of what arrived during the in-flight window.

If your compute fits the frame budget synchronously, `useDeferredValue` and `useTransition` are the right tools. If your compute is too heavy for the main thread and you've moved it to a Web Worker, the substrate is what addresses what async then exposes.

### State containers (Redux / MobX / Zustand / Jotai / XState)

State containers hold state — where session values live, how updates propagate to subscribers. The substrate aligns at the render-commit boundary when state becomes visible; orthogonal concerns. Wire your existing container into `useCoherentDerivation`'s `streaming` or `intent` slot — raw values for low-rate inputs (sliders, mode toggles), `Source<T>` for high-rate streams. The substrate commits the (input, output) pair coherently regardless of where the input came from.

### Dep-graph systems (`useMemo` / Solid signals / MobX reactions / Jane Street's Incremental)

Dep-graph systems orchestrate computation — what depends on what, when to recompute, how to propagate change. The substrate doesn't orchestrate; it observes outputs at commit. For multi-stage chains (factor decomposition → regime classifier → alert generator; ML inference pipelines), the consumer's dep-graph maintains snapshot identity through the chain, and the substrate observes the chain's tagged output and emits when it aligns. Topology declarations live in the consumer's dep-graph, not in the substrate.

### Stream libraries (RxJS / Most.js / Kefir)

Stream libraries transport values; they don't cross worker boundaries, don't carry snapshot identity for cross-async-stage composition, and don't integrate with `useSyncExternalStore`-class React subscription correctness. They're a fine consumer-side input layer (the upstream that feeds `streaming` and `intent`); they aren't the alignment-at-render-commit primitive. A naive `switchMap` chain handles pure-intent cancel-and-restart in ~10 lines but doesn't address mixed inputs, the worker boundary, atomic commit at render, SSR shape, or compute transport.

## Performance

The library is dispatch + alignment plumbing; the wall-clock latency you care about is your compute's. The library's own overhead:

- **Bundle**: <8 KB gz main + <3 KB gz worker (inlined; no separate worker file ships).
- **Worker spawn**: ~1–2 ms once per hook instance.
- **Per-compute overhead**: structured-clone of inputs across the `postMessage` boundary + bridge dispatch — typically under a millisecond for inputs in the tens-of-kilobytes range.
- **No main-thread blocking**: the compute itself never runs on the main thread.

Substrate compute is typically dominated by the consumer's own work (50–150 ms for a 70×200 SVI surface fit; hundreds of ms for scenario revaluations). The library's overhead is two-to-three orders of magnitude below that.

For high-frequency streaming (50–500 ticks/sec demonstrated in the [live demo](https://demo.oracaus.dev)), input conflation happens automatically — only the latest streaming value at compute completion kicks off the next compute. The hook does not queue per-tick; pending-task depth never exceeds one. Adopters wiring high-rate feeds should use the `Source<T>` path (typically via `useEventSource` — one line for a subscribe-shaped feed) so the host component renders at substrate commit cadence rather than at input rate.

## Limitations

- **No SSR.** `useSyncExternalStore`'s `getServerSnapshot` returns the initial state shape (`data: undefined`, `isComputing: false`, all snapshot ids `undefined`); no worker is created on the server. Hydration starts compute on the client at first effect.
- **Single worker per hook instance.** Each `useCoherentDerivation` mount creates one Web Worker; multiple mounts → multiple workers. There is no built-in worker pool — for adopters who need pooling, supply your own via `workerFactory`.
- **Module-worker browser support.** The default worker is constructed as a module worker (`{ type: "module" }`); requires Chrome 80+, Firefox 114+, Safari 15+. CSP environments disallowing the `Function` constructor must supply a `workerFactory` with a worker that has the compute statically.
- **Compute must be self-contained.** The default worker reconstructs `compute` via `new Function(compute.toString())`. The function cannot close over component state, hook results, or runtime-loaded modules. Bound functions, native functions, and host-provided functions (whose `toString()` produces `[native code]`) are detected and rejected with a clear error. For richer compute, use `workerFactory`.
- **Inputs must be `structuredClone`-able.** Class instances, functions, Maps with non-string keys, and similar non-cloneable values fail at runtime when posted to the worker.
- **No cross-instance coherence.** Two separate `useCoherentDerivation` calls maintain their own invariants independently — there is no built-in mechanism to commit their outputs against the same snapshot. For multi-derivation coherence against one input snapshot, bundle the derivations into a single `compute` function that returns a multi-field result (the substrate emits the bundle atomically).

## API

```ts
type ComputeFn<TStreaming, TIntent, TOutput> = (
  inputs: { streaming: TStreaming; intent: TIntent },
  signal: AbortSignal,
) => Promise<TOutput>;

interface Source<T> {
  readonly [SourceBrand]: true;
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
}

function useCoherentDerivation<TStreaming, TIntent, TOutput>(
  options:
    & {
        streaming?: TStreaming | Source<TStreaming>;
        intent?: TIntent | Source<TIntent>;
      }
    & (
      | { compute: ComputeFn<TStreaming, TIntent, TOutput>; workerFactory?: () => Worker }
      | { compute?: ComputeFn<TStreaming, TIntent, TOutput>; workerFactory: () => Worker }
    ),
): {
  data: TOutput | undefined;
  isComputing: boolean;
  dataSnapshotId: string | undefined;
  computingSnapshotId: string | undefined;
  error: unknown;
  cancel: () => void;
};

function useEventSource<T>(
  subscribe: (push: (value: T) => void) => () => void,
  initial?: T,
): Source<T>;

function useCallbackSource<T>(
  initial?: T,
): readonly [Source<T>, (value: T) => void];
```

Full per-field documentation in [`src/types.ts`](https://github.com/oracaus/oracaus/blob/master/packages/coherent-derivation/src/types.ts). The worker protocol types — `WorkerInbound`, `WorkerOutbound`, `ComputeRequest`, `AbortRequest`, `ResultResponse`, `ErrorResponse`, `WorkerCrashResponse`, `SerializedError`, `SnapshotId` — `ComputeFn`, and the `Source<T>` interface plus `SourceBrand` / `isSource` are also exported, semver-stable from v0.5.0. (`SnapshotId` is the branded-string type carried on every wire message's `id` field; adopters echo it back unchanged in their custom worker but never construct values of this type.)

## Why this exists

When heavy local compute (vol-surface fits, scenario revaluations, factor decompositions) runs in a Web Worker against state that mutates during the in-flight window, the result lands tagged to a snapshot the upstream has already moved past. Naive composition then paints a tuple from different upstream moments — a frame that never existed upstream. The class of UIs hitting this — trading-tech and adjacent real-time analytical workspaces — is small but growing.

The architectural argument is developed in the mini-series capstone: _The Anatomy of the Substrate for Substantive Screen-Side Derivation_ — published alongside this release.

## Project context

This package is one of three artefacts in the [oracaus repository](https://github.com/oracaus/oracaus):

- **This package** (`@oracaus/coherent-derivation`) — the library you install.
- **The [vol-surface demo](https://demo.oracaus.dev)** — naive-vs-gated panels showing what tearing looks like and the library's atomic-commit fix; full source in [`demo/`](https://github.com/oracaus/oracaus/tree/master/demo) including the reference custom-worker recipe ([`demo/src/worker/svi-worker.ts`](https://github.com/oracaus/oracaus/blob/master/demo/src/worker/svi-worker.ts)).
- **The [repository README](https://github.com/oracaus/oracaus/blob/master/README.md)** — project overview, recording walkthrough, articulation of where this library does and doesn't matter.

## Contributing

Issues and PRs welcome via [github.com/oracaus/oracaus/issues](https://github.com/oracaus/oracaus/issues). Development setup, contribution guidelines, security reporting, and the code of conduct are all in the [repository root](https://github.com/oracaus/oracaus) (`CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`).

## License

MIT © [Przemyslaw Kalka](https://www.linkedin.com/in/przemyslawkalka/?locale=en-US). See [LICENSE](./LICENSE).
