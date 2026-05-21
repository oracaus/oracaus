# Oracaus

A React hook for heavy async compute against streaming inputs — guarantees every emitted frame composes `(input, output)` from the same snapshot. (Think: a 60 ms vol-surface fit running against an option chain ticking at 100 Hz, or a slider drag at 60 Hz triggering scenario revaluation against live positions.)

**Live demo:** [demo.oracaus.dev](https://demo.oracaus.dev)

<!-- TODO post-recording (PLAN.md §C.4): replace this paragraph with the YouTube thumbnail embed:
[![Oracaus demo — 60–90s walkthrough](https://img.youtube.com/vi/VIDEO_ID/maxresdefault.jpg)](https://www.youtube.com/watch?v=VIDEO_ID) -->

_Recording walkthrough coming soon — open the [live demo](https://demo.oracaus.dev) in the meantime; the README's "Where to look" section orients further._

ESM only · React 18+ peer · Chrome 80+ / Firefox 114+ / Safari 15+ · `<` 8 KB gz main + `<` 3 KB gz worker · Worker protocol semver-stable from v0.5.0

## The problem

When async derivation runs longer than the interval between input changes — vol-surface fits against an option chain, scenario revaluation against position ticks, factor decomposition against live market data — the result lands tagged to a snapshot the live input has already moved past. Naive composition then paints a frame where derived state was computed against inputs that have changed; what the user sees is a tuple of values that never coexisted upstream.

`useCoherentDerivation` holds visible state during in-flight Web Worker compute, then emits the `(input, output)` pair tagged to the same snapshot. Inputs split into two named kinds — `streaming` (changes absorb; in-flight completes against its tagged snapshot) and `intent` (changes cancel-and-restart against the newest value). Mixed UIs declaring both are first-class.

## Quick example

```tsx
import { useCoherentDerivation } from "@oracaus/coherent-derivation";

function VolSurfacePanel({ chain }: { chain: OptionChain }) {
  const { data, isComputing } = useCoherentDerivation({
    streaming: { chain },
    compute: async ({ streaming }, signal) =>
      fitVolSurface(streaming.chain, signal),
  });

  if (data === undefined) return <Spinner />;
  return <Smile params={data} stale={isComputing} />;
}
```

The sections below frame _why-care_ → _is-this-for-me_ → _what-does-it-cost_; the full API surface, custom-worker recipe, and detailed reference live in the [library README](./packages/coherent-derivation/README.md).

## When does this matter?

The library is **a no-op when compute time stays inside the input interval** — the worker is idle between events, the queue can't accumulate, and naive composition would render coherently anyway. That's correct behaviour, not a bug; the library doesn't add latency to fast computes.

It becomes load-bearing when **any** of these is true:

| Condition                          | Realistic example                                               |
| ---------------------------------- | --------------------------------------------------------------- |
| Heavy compute per event (≥ 16 ms)  | Multi-slice vol-surface fit + Greeks + no-arb checks ≈ 30–50 ms |
| Compound compute pipeline          | Chain → SVI → P&L → risk metrics chained, totalling 50–100 ms   |
| Multi-instrument scatter-gather    | 100 instruments × 1 ms each = 100 ms per chain tick             |
| Monte Carlo / scenario revaluation | 100 scenarios × pricing = 50 ms–1 s                             |
| ML inference in the loop           | Even small models: 20–200 ms forward pass                       |
| User-driven high-frequency input   | Slider drag at 60 Hz emits inputs every ~16 ms                  |
| Slow client                        | 1 ms on M-series Mac → 50 ms on a budget Android — same code    |

The [demo](https://demo.oracaus.dev) is the easiest way to feel this — its expiry-count selector dials compute time from ~5 ms (no-op regime) up to 75 ms p99 (where naive starts to visibly tear).

## How it differs

- **React concurrent (`useDeferredValue` / `useTransition` / `Suspense`)** addresses _main-thread interruption_ — yielding mid-render to higher-priority work. It operates at the React scheduler. This library addresses a different problem: _alignment at render-commit between async compute and the inputs it was computed against_. The two are complementary, not substitutes.
- **Stream libraries (RxJS / Most.js / Kefir)** transport values; they don't cross worker boundaries, don't carry snapshot identity for cross-async-stage composition, and don't integrate with `useSyncExternalStore`-class React subscription correctness. They're a fine input layer feeding `streaming` / `intent`; they aren't the alignment-at-render-commit primitive.

Full differentiation in the [library README's `How this compares to ...` section](./packages/coherent-derivation/README.md).

## Headline performance

The library is dispatch + alignment plumbing; the wall-clock latency you care about is your compute's. The library's own overhead, all verified on M-series Mac:

| Metric               | Value                                                          |
| -------------------- | -------------------------------------------------------------- |
| Bundle (gz)          | < 8 KB main + < 3 KB worker (inlined; no separate worker file) |
| Worker spawn         | ~1–2 ms once per hook instance                                 |
| Per-compute overhead | structured-clone + bridge dispatch — < 1 ms for typical inputs |
| Main-thread blocking | None — compute runs in a Web Worker                            |

For high-frequency streaming inputs (50–500 ticks/sec demonstrated in the demo), input conflation is automatic — pending-task depth never exceeds one regardless of input rate.

## Browser support + limitations

**Module workers required.** Chrome 80+ / Firefox 114+ / Safari 15+ (all "latest stable" qualify; floor ≥ 2 years old). CSP environments disallowing `Function` constructor must supply a [`workerFactory`](./packages/coherent-derivation/README.md#custom-workers-for-non-trivial-compute) — the demo's `svi-worker.ts` is the reference recipe.

**Known limitations** (full list in the library README):

- **No SSR** — `useSyncExternalStore`'s `getServerSnapshot` returns the initial-state shape; no worker on the server.
- **Single worker per hook instance** — no built-in pool; supply your own via `workerFactory` if pooling matters.
- **Default-worker compute must be self-contained** — reconstructed via `new Function(compute.toString())`; cannot close over component state, hook results, or runtime-loaded modules. Bound / native / host functions detected and rejected with a clear error.
- **Inputs must be `structuredClone`-able** — class instances, functions, Maps with non-string keys, and similar non-cloneable values fail at runtime when posted to the worker.
- **No cross-instance coherence** — two `useCoherentDerivation` calls maintain their own invariants independently. For multi-derivation coherence against one input snapshot, bundle into one `compute` that returns a multi-field result.

## Migration cost

For an existing component that does heavy compute against streaming inputs:

- **Minimal change shape**: wrap the compute callback in `useCoherentDerivation({ streaming, compute })`, render against `data` + `isComputing`. That's the one-line adoption.
- **Inputs to split** — if your existing code conflates "values that should restart compute" with "values that should absorb", you'll need to declare them in the two-slot `{ streaming, intent }` shape. Often this surfaces a clarification the existing code was already informally making.
- **Worker boundary** — if your compute imports across modules / closes over runtime state, the default `new Function` reconstruction won't work; either inline the compute or supply a bundled `workerFactory`. Bundler config is one extra line for Vite (`?worker` import suffix).
- **Peer dependency**: React 18 or newer. ESM only.
- **Worker protocol** is exported and **semver-stable from v0.5.0** — adopters with custom workers won't be forced into rewrites by patch / minor releases.

## Where to look

| You want to ...                       | Look at                                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install and use the library           | [Library README](./packages/coherent-derivation/README.md)                                                                                                        |
| See it run                            | [Live demo](https://demo.oracaus.dev)                                                                                                                   |
| Read the demo source                  | [`demo/`](./demo)                                                                                                                                                 |
| Understand the architectural argument | [The pivot article](https://www.linkedin.com/pulse/pivot-narrowing-scope-substantive-screen-side-derivation-ka%C5%82ka-bexuf/) — mini-series capstone forthcoming |

## Repository layout

An npm workspaces monorepo.

| Path                            | What it is                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/coherent-derivation/` | The public library. Hook + worker bootstrap + strategy logic. v0.5.0 publish target.                                                                                                                                  |
| `packages/connection-layer/`    | Workspace-internal design reference (SharedWorker orchestrator, `BackpressureValve`, multi-tab patterns). Not on the publish path.                                                                                    |
| `demo/`                         | The v0.5.0 demo. SVI vol-surface fitting under a streaming option chain, naive vs. gated side-by-side. The custom-worker recipe (`demo/src/worker/svi-worker.ts`) is the canonical reference for non-trivial compute. |

## Develop

`npm install` + `npm test` from the repository root. Full command list, contribution guidelines, security reporting, and code of conduct live in [`CONTRIBUTING.md`](./CONTRIBUTING.md) (with cross-links to [`SECURITY.md`](./SECURITY.md) and [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)).

## Author

[Przemyslaw Kalka](https://www.linkedin.com/in/przemyslawkalka/?locale=en-US) — building real-time risk and trading interfaces across FX, Fixed Income, Derivatives and Commodities.

## License

MIT. See [LICENSE](./LICENSE).
