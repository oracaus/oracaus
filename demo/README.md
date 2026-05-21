# Oracaus demo

Companion demo for [`@oracaus/coherent-derivation`](https://www.npmjs.com/package/@oracaus/coherent-derivation) — naive-vs-gated panels side-by-side, same SVI fitter running in both, demonstrating what the library's atomic-commit alignment fixes vs what naive React-state composition can't.

**Live demo:** [demo.oracaus.dev](https://demo.oracaus.dev)

Two panels. **NAIVE** — chain ticks sourced directly from the feed's throttled view; fit result lands independently from a worker — tears under streaming load: the rendered frame pairs the latest chain with whatever fit just landed, computed against an older chain. **GATED** — same worker, same fitter, same observed quotes; routed through `useCoherentDerivation` — commits `(input, output)` atomically and never tears. Trigger the vol-shock burst to see the contrast.

## Run locally

```bash
# from repo root
npm install
npm run -w @oracaus/coherent-derivation build
npm run -w @oracaus/demo dev
```

The dev server prints the local URL (typically `http://localhost:5173/`). HMR-enabled; edits to demo source or library source reflect immediately.

## URL parameters

- `?seed=<int>` — locks the synthetic feed's PRNG. Same seed → byte-identical tick sequence across machines.
- `?mode=recording` — locks initial config and disables hover affordances that don't film well. Use for reproducible recording takes.

## How it's wired

Both panels run their own Web Worker (`src/worker/svi-worker.ts`) that bundles the SVI fitter directly. The workers are passed to `useCoherentDerivation` via `workerFactory`; **`compute` is omitted on the hook call** — the worker has the fitter statically and never needs the function to cross as a string.

The SVI fitter is ~1 300 lines across nine TS files with imports between them; it cannot cross the worker boundary as a stringified closure (`new Function(source)` has no module resolution). The custom-worker pattern is the canonical adopter recipe for non-trivial compute — see the [library README](../packages/coherent-derivation/README.md#custom-workers-for-non-trivial-compute) for the general pattern.

The gated panel uses the library's `useEventSource` to bridge the feed-tick stream into the substrate in one call. Pushes arrive at the worker at the full upstream rate (50–500 Hz) without forcing a React re-render on every tick. The substrate's conflate-on-streaming policy engages because the substrate sees the raw stream:

```ts
import {
  useCoherentDerivation,
  useEventSource,
} from "@oracaus/coherent-derivation";

const workerFactory = () =>
  new Worker(new URL("./worker/svi-worker.ts", import.meta.url), {
    type: "module",
  });

// `useEventSource` bridges the feed's subscribe-shaped interface into
// a `Source<DemoInput>` and handles subscribe/cleanup lifecycle.
const tickSource = useEventSource<DemoInput>(
  (push) => subscribeTick((tick) => push(toDemoInput(tick))),
  PLACEHOLDER,
);

// Generics carry input/output types since `compute` is absent.
const { data, isComputing } = useCoherentDerivation<
  DemoInput,
  undefined,
  DemoOutput
>({
  streaming: tickSource,
  workerFactory,
});
```

The naive panel deliberately bypasses this: it posts on every tick to the same worker without the substrate's gating, so the React state for chain and fit land in independent slots — the architectural anti-pattern the demo demonstrates against.

## Architecture

```
src/
  App.tsx              # entry — wires feed, panels, controls, commentary
  feed.ts              # SyntheticFeed (PRNG, GBM, OU, IV emission)
  metrics.ts           # per-mode lag formula (computeSnapshotLag — single source of truth)
  hooks/
    use-feed.ts        # React hook around SyntheticFeed
    use-naive-fit.ts   # NAIVE panel state — own worker, ungated
    use-gated-fit.ts   # GATED panel state — own worker, library-gated
  worker/
    svi-worker.ts      # custom Worker bundling the SVI fitter
    compute-surface.ts # pure surface-compute function (fits + repair + assembly)
  svi/                 # SVI fitter (used by the worker)
  commentary/          # live narration engine — phase machine + scenarios + events + toasts
  components/          # UI: Smile, Panel, Controls, OptionChainTable, CommentaryToastStack, etc.
```

Implementation deep-dives — cross-view hover overlay, adaptive y-axis via the Web Animations API, viewport-too-small notice, the metric-coherence structural fix — live in the repository root [`CLAUDE.md`](../CLAUDE.md).

## Synthetic feed — generative model

`src/feed.ts` (`SyntheticFeed` class):

- **Spot** evolves as geometric Brownian motion: `S_{t+Δt} = S_t · exp((r − σ_spot²/2)·Δt + σ_spot·√Δt · z)`, `z ~ N(0, 1)`. Defaults: `r = 0.05`, `σ_spot = 0.20`, `Δt = 1 trading day / (252 · 50)`.
- **True SVI parameters** evolve as Ornstein-Uhlenbeck random walks. Each parameter `(a*, b*, ρ*, m*, σ*)` mean-reverts to an SPX-style anchor (`a* = 0.04`, `b* = 0.1`, `ρ* = -0.5`, `m* = 0`, `σ* = 0.2`). Per-tick diffusion is small under no-shock; vol shock multiplies diffusion × 5 for 10 seconds.
- **Per-tick observed IV** at strike `k_i`: `IV_i = √(w(k_i, true_params) / T) + ε`, `ε ~ N(0, σ_iv²)`, `σ_iv = 0.001` (10 bps, SPX-ATM-realistic).

The PRNG is `mulberry32`; same seed → same sequence everywhere. Read the model end-to-end and run the demo locally with your own seed to confirm the failure mode is structural, not stage-managed.

## Failure regime

A 50-strike single-slice fit clears in ~0.5 ms p99. At 50 ticks/sec (20 ms gap) the fit completes ~40× faster than the inter-tick interval — nothing tears.

The default surface is **70 expiries × 200 strikes** (~75 ms p99 warm on M-series Mac), the middle of the Form 2 zone [50, 150] ms. At 50 Hz feed rate the fit time exceeds the inter-tick interval; NAIVE's curve and dots desynchronise visibly while GATED holds.

The expiry count is user-selectable via the top-bar `expiries` stepper from `{12, 30, 50, 70, 80}` — the production-meaningful axis for varying per-tick compute. Each step's tooltip shows estimated p99 compute so the viewer can predict their Form 2 zone position.

## Browser support

Module workers (`new Worker(url, { type: "module" })`) are required:

| Browser | Floor                |
| ------- | -------------------- |
| Chrome  | 80+ (Feb 2020)       |
| Edge    | 80+ (follows Chrome) |
| Firefox | 114+ (June 2023)     |
| Safari  | 15+ (Sep 2021)       |

All "latest stable" qualify (≥2 years old). Older browsers receive a graceful "module workers required" notice rather than a broken demo. Mobile is unsupported — the desk-operator register and dense two-panel layout target desktop.

## What to read next

- **[Repository README](../README.md)** — project overview, when this library matters, where it differs from React concurrent / stream libs, migration cost.
- **[Library README](../packages/coherent-derivation/README.md)** — full API surface, custom-worker recipe, performance breakdown, limitations.
- **[PLAYBOOK.md](./PLAYBOOK.md)** — scenario-by-scenario operating instructions; what to watch for at each setting, narration scripts for live demos, troubleshooting.
- **[CLAUDE.md](../CLAUDE.md)** — codebase-level architecture; the substrate's invariants; SVI fitter rationale; the per-mode lag formula's history.
