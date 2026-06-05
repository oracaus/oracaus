# Oracaus

A React hook that keeps your UI coherent when async compute can't finish before the next input arrives — pairs every emitted output with the exact input snapshot it was computed against, so the rendered frame never shows derived values that don't match the inputs they were computed against. (Think: an APM tool re-aggregating p99 over a filtered 60-second span buffer, or a ~58 ms vol-surface fit against an option chain ticking at 50 Hz.)

**[Open the live demo at demo.oracaus.dev](https://demo.oracaus.dev)**

[![Oracaus demo walkthrough — click to watch on YouTube](https://img.youtube.com/vi/CH8vc6owIUI/maxresdefault.jpg)](https://www.youtube.com/watch?v=CH8vc6owIUI)

▶ **[Watch the walkthrough on YouTube](https://www.youtube.com/watch?v=CH8vc6owIUI)**

ESM only · React 18+ peer · Chrome 80+ / Firefox 114+ / Safari 15+ · ~3 KB gz (worker inlined) · Worker protocol semver-stable from v0.5.0

v0.5.0 — API stable in shape, semver-stable worker protocol; v1.0.0 reserved for refinement after a feedback period. Architectural rationale: [the pivot article](https://www.linkedin.com/pulse/pivot-narrowing-scope-substantive-screen-side-derivation-ka%C5%82ka-bexuf/) and [the mini-series capstone](https://www.linkedin.com/pulse/anatomy-substrate-substantive-screen-side-derivation-przemys%C5%82aw-ka%C5%82ka-iklae/).

> **The architectural choice.** Inputs split into two kinds: **streaming** changes absorb — market ticks, event streams, sensor feeds; in-flight completes against its tagged value. **Intent** changes cancel and restart — slider drags, mode toggles, parameter tweaks; supersede in-flight against the newest value. Mixed UIs declaring both are first-class. The rest is mechanism.

```text
Without coherence:

  Input @ snapshot N+3 ──────────────► render
                                         ▲
  compute(N) ──► Output @ N ─────────────┘

  Render = (Input@N+3, Output@N)   ⚠ a tuple that never existed upstream


With useCoherentDerivation:

  compute(N) ──► (Input@N, Output@N) ──► render

  Render = (Input@N, Output@N)     ✓ a real past state of the upstream
```

## Quick example

```bash
npm install @oracaus/coherent-derivation
```

```tsx
import { useCoherentDerivation, type Source } from "@oracaus/coherent-derivation";

function ComputePanel({
  inputStream,
  smoothing,
  mode,
}: {
  inputStream: Source<Input>;
  smoothing: number;
  mode: "fast" | "precise";
}) {
  const { data, isComputing } = useCoherentDerivation({
    streaming: inputStream,                    // changes absorb
    intent: { smoothing, mode },               // changes cancel and restart
    compute: async ({ streaming: input, intent }, signal) =>
      runHeavyCompute(input, intent.smoothing, intent.mode, signal),
  });

  if (data === undefined) return <Spinner />;
  return <ResultView data={data} stale={isComputing} />;
}
```

**`Source<T>`** is the library's high-rate input shape — construct with `useEventSource(subscribe)` for subscribe-shaped feeds or `useCallbackSource()` for imperative-push flows; both exported. **Raw values** work for low-rate inputs (sliders, mode toggles, feeds already in React state) — pass directly into `streaming` or `intent`. **Multiple values in a slot** wrap as an object (`streaming: { chain, positions }`); for multiple high-rate Sources, aggregate into one composite Source — the `isSource` check is top-level, so a wrapping object is treated as raw. Full patterns: [Two input kinds](./packages/coherent-derivation/README.md#two-input-kinds) and [High-rate streaming](./packages/coherent-derivation/README.md#high-rate-streaming-inputs) in the library README.

The default worker reconstructs `compute` via `compute.toString()`, so it must be self-contained — no closure over component state, no imports of runtime-loaded modules. For non-trivial compute, supply a [`workerFactory`](./packages/coherent-derivation/README.md#custom-workers-for-non-trivial-compute) with the compute statically embedded; the demo's `svi-worker.ts` is the reference recipe.

Full API surface and reference: [library README](./packages/coherent-derivation/README.md).

## The problem

Most adopters discover this failure mode after building it: cross-panel disagreement under load, race conditions between async results and live inputs, values that look correct individually but disagree when displayed together. The shape that unit tests pass but composition fails. Naming the pattern is half the fix.

The underlying mechanism: when async derivation takes longer than the interval between input changes, the result lands tagged to a snapshot the live input has already moved past. In everyday React terms: **stale derived values sitting next to fresh inputs**, **race conditions between independent state slots**, **out-of-order async responses** landing into a render where the input has already moved on. Naive composition then paints a frame where derived state was computed against inputs that have changed; what the user sees is a tuple of values that never coexisted upstream. The pattern shows up in ad-hoc client-side filtering over streaming telemetry, vol-surface fits against an option chain, ML scoring against live sensor inputs, and scenario revaluation against position ticks.

**Concretely**: the same shape repeats across domains. An observability dashboard's p99 line shows 240 ms while the spans table next to it lists three recent 480 ms outliers. A vol-surface chart shows σ = 18% while the chain row beside it implies σ = 22% — the trader prices, hedges, and books against a state that never existed (operational risk, not a UI bug). Each composition was correct at its own moment; neither existed upstream as a single state.

Trading UIs are the most demanding instance of this shape; the same failure surfaces wherever heavy client-side derivation runs against streaming canonical state.

`useCoherentDerivation` holds visible state during in-flight Web Worker compute, then emits the `(input, output)` pair tagged to the same snapshot. Every committed frame is a real past state of the upstream, never a stitched composition of fresh inputs and outputs from older state.

## What this owns

**The library handles**: the worker boundary (spawn, terminate, lifecycle), async cancellation via `AbortSignal`, streaming-input conflation, snapshot-tagged `(input, output)` commits, render-commit alignment.

**You bring**: the stream (WebSocket, SSE, polling, your bus — wrap into a `Source<T>`); compute orchestration above a single derivation (multi-stage chains belong in your dep-graph — Solid signals, MobX reactions, `useMemo`); a `workerFactory` if you need worker pooling (one worker per hook by default); SSR-friendly fallbacks if you need them (initial-state shape returned on the server; worker spawns on first client effect).

## When does this matter?

The library is **a no-op when compute time stays inside the input interval** — the worker is idle between events, the queue can't accumulate, and naive composition would render coherently anyway. That's correct behaviour, not a bug; the library doesn't add latency to fast computes.

It becomes load-bearing where four conditions hold at once:

1. **Canonical streaming state lives upstream** — a market-data feed, an option chain, a ticking position book the middle tier serves to every consumer.
2. **The compute is personalised and interactive** — a per-user fit, scenario set, or structure that can't sit server-side at per-user scale without forcing the middle tier to compute N views per tick.
3. **A human reads the result and acts on it** — quotes, hedges, adjusts skew, sizes a structure, sets a limit — fast enough and with enough at stake that a frame composing output against inputs that have already moved is a *costly error*, not a cosmetic flicker.
4. **The compute is heavy enough that coarse gating can't save you** — throttling inputs to a slower cadence shrinks the collision window but doesn't close it once the compute itself exceeds the gating interval.

Trading and risk surfaces are the wedge: the most demanding instance of this shape, and where the proof cases live. The pattern generalises to any real-time interface that meets all four conditions — but where it doesn't (compute the middle tier could do cheaply; a frame only ever glanced at, never acted on; coarse gating that's good enough), coherence is a convenience, not a correctness property, and you don't need this.

| Pattern | Realistic example | Why coherence is correctness here |
| --- | --- | --- |
| Vol-surface fit + Greeks (market-maker surface) | Multi-slice raw-SVI fit + Greeks + no-arb ≈ 30–50 ms against an option chain ticking 50–200/sec | The trader adjusts skew, widens, or pulls off the displayed surface; one fitted to a chain that has already moved drives a mis-judged intervention — this is the demo |
| Scenario revaluation against ticked positions | 100 custom scenarios × per-scenario pricing = 50 ms–1 s against a portfolio ticking at ~50 ms | The risk manager hedges and sets limits off the stress aggregate; the compute exceeds any gating interval, so coalescing *can't* close the window — only coherent commit can |
| Interactive GPU Monte Carlo (what-if P&L surface) | 100k-path P&L surface on a consumer GPU at 30–200 ms/dispatch; slider-driven perturbation grid against streaming market data | A surface whose perturbation grid disagrees with the (spot, vol) the run used is a chimera P&L for a tuple that never existed at any instant |
| Multi-leg aggregate over a streamed ladder | Per-leg book-aware metrics (margin, vol-bucket exposure, correlation) against a streamed price ladder; ≈ 20–40 ms | The structurer prices off the aggregate; vertical tearing along the streamed/derived split misstates the structure's margin at the moment of the decision |

The threshold isn't fixed at 16 ms — the React frame budget is single-digit ms in practice (browser + scheduler take their share of the 16 ms / 8 ms frame interval), and the library's domain is async compute past the **inter-snapshot interval** (≈ 20 ms at 50 Hz inputs; ≈ 10 ms at 100 Hz). The boundary is empirical and device-relative: the same compute that's 1 ms on a developer's M-series Mac can be 50 ms on a user's budget Android, crossing the threshold only on the slower device. It shifts with cadence, fan-out, and scale.

The [demo](https://demo.oracaus.dev) is the easiest way to feel this. Two selectors: per-tick compute (~15 ms → ~92 ms p99 across 12 → 80 expiries) and inter-snapshot interval (20 ms → 2 ms across 50 → 500 Hz). Naive tears when compute exceeds interval — steady at defaults (~58 ms vs 20 ms), dramatic at the upper corner (~92 ms vs 2 ms).

## How it differs

- **React concurrent (`useDeferredValue` / `useTransition` / `Suspense`)** addresses _main-thread interruption_ — yielding mid-render to higher-priority work. It operates at the React scheduler. This library addresses a different problem: _alignment at render-commit between async compute and the inputs it was computed against_. The two are complementary, not substitutes.
- **Stream libraries (RxJS / Most.js / Kefir)** transport values; they don't cross worker boundaries, don't carry snapshot identity for cross-async-stage composition, and don't integrate with `useSyncExternalStore`-class React subscription correctness. They're a fine input layer feeding `streaming` / `intent`; they aren't the alignment-at-render-commit primitive.
- **Throttle / debounce (coalesced inputs)** addresses the same failure mode with a different trade — gate inputs to a coarser cadence (typically 5–10 Hz), and most computes fit within the wider gating interval. Cost: freshness — the application runs compute against staler inputs by design. The library's value scales with the compute-to-inter-snapshot-interval ratio; coalesced architectures shrink that ratio but don't close it for computes that exceed the gating interval, and intent-input coherence persists either way.

Full differentiation in the [library README's `How this compares to ...` section](./packages/coherent-derivation/README.md).

## What's the cost?

The library doesn't add latency to your compute — async work takes its own time regardless of whether the host paints during the in-flight window or holds. What changes is the visible commit cadence: frames update when compute completes rather than at upstream input rate. Naive composition preserves input freshness but not input/output coherence — it paints fresh inputs alongside output that was computed against older state, a tuple that never existed upstream. The library commits real `(input, output)` pairs from past states the upstream actually held.

## Headline performance

The library is dispatch + alignment plumbing; the wall-clock latency you care about is your compute's. The library's own overhead, all verified on M-series Mac:

| Metric               | Value                                                          |
| -------------------- | -------------------------------------------------------------- |
| Bundle (gz)          | ~3 KB total (one file; worker source inlined for Blob-URL spawning, no separate worker file) |
| Worker spawn         | ~1–2 ms once per hook instance                                 |
| Per-compute overhead | structured-clone + bridge dispatch — < 1 ms for typical inputs |
| Main-thread blocking | None — compute runs in a Web Worker                            |

For high-frequency streaming inputs (50–500 ticks/sec demonstrated in the demo), input conflation is automatic — pending-task depth never exceeds one regardless of input rate.

All numbers reproducible. Bench sources: [`packages/coherent-derivation/test/bundle-size.test.ts`](./packages/coherent-derivation/test/bundle-size.test.ts) (bundle), [`demo/bench/svi.bench.ts`](./demo/bench/svi.bench.ts) (SVI workload). CI-budget methodology in [`demo/test/svi-perf.test.ts`](./demo/test/svi-perf.test.ts). Run `npm run bench` from the repo root to reproduce on your hardware.

## Browser support + limitations

**Module workers required.** Chrome 80+ / Firefox 114+ / Safari 15+ (all "latest stable" qualify; floor ≥ 2 years old). CSP environments disallowing `Function` constructor must supply a [`workerFactory`](./packages/coherent-derivation/README.md#custom-workers-for-non-trivial-compute) — the demo's `svi-worker.ts` is the reference recipe.

**Known limitations** (full list in the library README):

- **No SSR** — `useSyncExternalStore`'s `getServerSnapshot` returns the initial-state shape; no worker on the server.
- **Single worker per hook instance** — no built-in pool; supply your own via `workerFactory` if pooling matters.
- **Default-worker compute must be self-contained** — reconstructed via `new Function(compute.toString())`; cannot close over component state, hook results, or runtime-loaded modules. Bound / native / host functions detected and rejected with a clear error.
- **Inputs must be `structuredClone`-able** — class instances, functions, Maps with non-string keys, and similar non-cloneable values fail at runtime when posted to the worker.
- **No cross-instance coherence** — two `useCoherentDerivation` calls maintain their own invariants independently. For multi-derivation coherence against one input snapshot, bundle into one `compute` that returns a multi-field result.

## Adoption shape

For a component that does heavy compute against streaming inputs — new or existing:

- **Two adoption paths**. Inline `compute` for self-contained functions (no module imports, no closures over component state) — the library reconstructs and runs it in its bundled worker. Custom `workerFactory` returning your own bundled Worker for substantive compute with module imports — **the production path for non-trivial work**; the demo's [`svi-worker.ts`](./demo/src/worker/svi-worker.ts) is the canonical recipe. The inline path is the right shape for prototypes and self-contained transforms; assume you'll move to `workerFactory` once your compute reaches across modules.
- **Inputs to split** — if your existing code conflates "values that should restart compute" with "values that should absorb", you'll need to declare them in the two-slot `{ streaming, intent }` shape. Often this surfaces a distinction the existing code was already informally making.
- **Bundler compatibility** — for the `workerFactory` path, the W3C-standard `new Worker(new URL(path, import.meta.url), { type: "module" })` pattern is supported natively by Vite, Webpack 5+, Rollup, Parcel 2+, and esbuild without bundler-specific configuration.
- **Peer dependency**: React 18 or newer. ESM only.
- **Worker protocol** is exported and **semver-stable from v0.5.0** — adopters with custom workers won't be forced into rewrites by patch / minor releases.

## Next steps

Ready to adopt? Pick where to go.

| Next step                          | Where                                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install and start building         | `npm install @oracaus/coherent-derivation` → [library README](./packages/coherent-derivation/README.md) for the API + recipes                                     |
| Watch it run                       | [Live demo at demo.oracaus.dev](https://demo.oracaus.dev)                                                                                                         |
| Read the demo source               | [`demo/`](./demo) — including the custom-worker recipe at [`demo/src/worker/svi-worker.ts`](./demo/src/worker/svi-worker.ts)                                       |
| Read the architectural argument    | [The pivot article](https://www.linkedin.com/pulse/pivot-narrowing-scope-substantive-screen-side-derivation-ka%C5%82ka-bexuf/) and [the mini-series capstone](https://www.linkedin.com/pulse/anatomy-substrate-substantive-screen-side-derivation-przemys%C5%82aw-ka%C5%82ka-iklae/) |

## Repository layout

An npm workspaces monorepo.

| Path                            | What it is                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/coherent-derivation/` | The public library. Hook + worker bootstrap + strategy logic. v0.5.0 publish target.                                                                                                                                  |
| `packages/connection-layer/`    | Workspace-internal design reference (SharedWorker orchestrator, `BackpressureValve`, multi-tab patterns). Not on the publish path.                                                                                    |
| `demo/`                         | The v0.5.0 demo. SVI vol-surface fitting under a streaming option chain, NAIVE vs ORACAUS side-by-side. The custom-worker recipe (`demo/src/worker/svi-worker.ts`) is the canonical reference for non-trivial compute. |

## Develop

`npm install` + `npm test` from the repository root. Full command list, contribution guidelines, security reporting, and code of conduct live in [`CONTRIBUTING.md`](./CONTRIBUTING.md) (with cross-links to [`SECURITY.md`](./SECURITY.md) and [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)).

## Author

[Przemyslaw Kalka](https://www.linkedin.com/in/przemyslawkalka/?locale=en-US) — building real-time risk and trading interfaces across FX, Fixed Income, Derivatives and Commodities, where heavy compute meets fast-moving data. This library distils a correctness problem from that work.

## License

MIT. See [LICENSE](./LICENSE).
