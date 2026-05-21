# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Oracaus — compute-quantum render alignment for heavy local compute against streaming inputs in React. v0.5.0 is the first release under this direction; the pre-pivot v0.4.0 (a per-stream causal-coherence library for trading UIs) is preserved in git history.

The architectural rationale for the v0.5.0 direction lives in the [pivot article](https://www.linkedin.com/pulse/pivot-narrowing-scope-substantive-screen-side-derivation-ka%C5%82ka-bexuf/).

## Commands (run from repo root)

```bash
npm install         # resolve workspaces
npm run build       # tsc --build (project references); does NOT bundle
                    # — coherent-derivation has its own bundling step
npm run build:clean # tsc --build --clean
npm run typecheck   # tsc --build
npm test            # vitest run across workspaces
npm run test:memory # vitest run with NODE_OPTIONS=--expose-gc; runs the
                    # heap-delta tests that self-skip otherwise
npm run bench       # vitest bench
npm run bench:memory  # vitest bench with --expose-gc for heap measurements
npm run lint        # biome lint
npm run format      # biome format --write
npm run check       # biome check (lint + format)

# Per-package: coherent-derivation has its own build pipeline (esbuild bundle
# + tsc .d.ts emission) since `tsc --build` doesn't bundle.
npm run -w @oracaus/coherent-derivation build         # full bundle (esbuild)
npm run -w @oracaus/coherent-derivation build:clean   # wipe dist/
```

The pre-commit hook runs `biome check --staged`. Do not bypass it.

## Repository layout

npm workspaces monorepo:

```
packages/
  coherent-derivation/   # public library; v0.5.0 publish target
    src/
      types.ts           # locked v0.5.0 public type surface
      index.ts           # public re-exports
      use-coherent-derivation.ts  # the hook (the only public runtime export)
      worker.ts          # worker entry; bundled to a string and inlined into
                         # the main bundle by `scripts/build.mjs`
      types/
        build-globals.d.ts  # `declare const __WORKER_SOURCE__: string`
      internal/          # not exported; implementation
        worker-bootstrap.ts # spawnWorker — Blob URL from `__WORKER_SOURCE__`
        worker-protocol.ts  # WorkerInbound / WorkerOutbound discriminated unions
        worker-loop.ts      # WorkerLoop + ComputeRunner + productionRunner
                            # (the new Function reconstruction)
        worker-bridge.ts    # main-thread WorkerLike adapter
        snapshot-id.ts      # SnapshotId branded type + SnapshotIssuer
        assert-never.ts     # exhaustiveness helper
        serialize-error.ts  # `serializeError` / `deserializeError`
        strategies/
          strategy-state.ts            # shared state shape + initialState
          derivation-strategy.ts       # single state machine: cancel on intent change, absorb on streaming change
    scripts/
      build.mjs          # tsc -b → esbuild worker → esbuild main with
                         # `__WORKER_SOURCE__` substitution
    test/
      utils/             # FakeWorker, computeRequest helper
      *.test.ts          # unit + property + memory + bundle-size tests
  connection-layer/      # workspace-internal; not published in v0.5.0
    src/
      types.ts           # branded primitives, wire types, CausalMetadata,
                         # WorkerInbound, WorkerOutbound, ConnectionStatus
      backpressure-valve.ts
      orchestrator.worker.ts  # SharedWorker; single WebSocket; routes via valve + broadcast
      client-bridge.ts        # tab-side interface; per-stream subscription handlers
      react/
        use-trading-stream.ts # React hook (subpath export ./react)
      index.ts
    bench/
      valve-throughput.bench.ts
demo/                    # the v0.5.0 demo (top-level; single demo, no apps/ wrapper)
  src/main.tsx           # the SVI vol-surface demo entry component
  src/svi/               # Phase 2: per-slice raw-SVI calibration (the demo's
                         # reference compute, not a library primitive)
    params.ts            # branded SviParams + validateParams + level floor
    svi.ts               # w(k, params); Slice + Quote types
    jacobian.ts          # 5 raw partials + reparametrised partials with chain rule
    reparam.ts           # softplus / sigmoid / atanh ↔ tanh transforms
    lm-solver.ts         # generic Levenberg-Marquardt (no SVI knowledge)
    initial-guess.ts     # Zeliade 2-D outer grid + closed-form inner LS
    no-arb.ts            # Gatheral g(k) butterfly + calendar checks
    fitter.ts            # composed pipeline + discriminated-union FitResult
    diagnostics.ts       # per-point hover-overlay diagnostics — analytical
                         # dw/dk and d²w/dk² in k; re-exports gatheralG
    index.ts             # demo-internal re-exports
  test/
    fixtures/
      gatheral-spx.json      # synthetic SVI calibration data + citation
      scipy-reference.json   # scipy cross-validation reference
    *.test.ts                # demo tests — see § Test suite below for breakdown
  bench/
    svi.bench.ts             # vitest bench (single + full surface)
  tools/
    generate-scipy-reference.py  # one-shot regen; not run in CI
    requirements.txt             # pinned scipy 1.13.0, numpy 1.26.4
    README.md                    # regeneration workflow
  tsconfig.test.json     # mirrors coherent-derivation; included in npm run typecheck
```

## Locked API

Single primitive: `useCoherentDerivation<TStreaming, TIntent, TOutput>(options)`. Inputs are split into two named slots:

- `streaming` — changes do not cancel in-flight compute; the in-flight completes against its tagged snapshot, then the next compute kicks off against whichever streaming value is current at completion. Use for option-chain ticks, position updates, market-data feeds.
- `intent` — changes cancel the in-flight compute and restart against the newest value. Use for slider drags, parameter tweaks, mode selections.

Either or both can be supplied. Mixed UIs (streaming chain plus user-controlled fit parameters) are first-class; the substrate cancels on intent change and absorbs on streaming change automatically.

Both slots accept either a **raw value** or a **`Source<T>`** — a subscription-shaped value following `useSyncExternalStore`'s shape. Raw values are the right shape for low-rate inputs (sliders, mode toggles) and for adopters whose feed already lands in React state. For high-rate streaming inputs (option chains at 50–500 ticks/sec, position updates, sensor streams — anything with a `subscribe(cb) → unsubscribe` shape), use **`useEventSource`** — one line that bridges the feed into a `Source<T>`. The substrate subscribes once and consumes pushes through that subscription; the host component renders at substrate commit cadence rather than at input rate. Without the Source path, host re-renders fire per push and pre-coalesce inputs before the substrate sees them — defeating the streaming-input architecture's whole premise. `useCallbackSource` is the imperative sibling — returns `[Source, push]` for event-handler-driven flows.

A third option ("always-latest", no gate) was deliberately omitted — equivalent to "do not use this library for this case".

Full type surface: [`packages/coherent-derivation/src/types.ts`](./packages/coherent-derivation/src/types.ts).

## Status

v0.5.0 in development. Implementation complete (library + demo); pre-publish work tracked separately. v1.0.0 designation reserved for after a feedback period with real adopters.

The v0.4.0 RenderGate (cross-stream causal coherence) was stripped during the v0.5.0 baseline work; the surrounding connection layer (SharedWorker + BackpressureValve + BroadcastChannel + ClientBridge + useTradingStream) was kept and rewritten to drop the gate dependency. Per-stream messages now flow through unchanged; cross-stream alignment is the consumer's job (or the middle tier's). See the [pivot article](https://www.linkedin.com/pulse/pivot-narrowing-scope-substantive-screen-side-derivation-ka%C5%82ka-bexuf/) for rationale.

## `@oracaus/coherent-derivation` package layout

The public API is `useCoherentDerivation<TStreaming, TIntent, TOutput>(options)`. The hook decomposes into:

- **`StrategyHandle`** (in `src/use-coherent-derivation.ts`) — stable reactive store created once per component instance via `useState`. Owns the subscriber set + the snapshot read by `useSyncExternalStore`. Strategy attaches/detaches around it across Strict Mode's effect setup → cleanup → setup cycle without losing subscribers.
- **`CoherentDerivationStrategy`** (`src/internal/strategies/derivation-strategy.ts`) — single state machine for the substrate. Tracks `lastStreamingRef` and `lastIntentRef` by identity; on `setInputs(streaming, intent, source)`:
  - Intent ref changed during in-flight compute: send `{ type: "abort" }`, drop any pending streaming-only update, start fresh compute against the new (streaming, intent) pair.
  - Streaming-only ref changed during in-flight compute: conflate into a single `pendingTask`; let the in-flight finish; kick off the pending task on completion.
  - No in-flight compute: start immediately.
  - Stale-response handling: late-arriving results for superseded snapshot ids are dropped via `currentSnapshotId` mismatch.
- **`WorkerBridge`** (`src/internal/worker-bridge.ts`) — main-thread adapter over a `WorkerLike` (real `Worker` or `FakeWorker` for tests). Stable subscribe/terminate.
- **`WorkerLoop`** (`src/internal/worker-loop.ts`) — worker-side message dispatch. Each compute creates an `AbortController`; `abort` messages look up the controller. Result/error dropped if signal aborted before resolution.
- **`SnapshotIssuer`** (`src/internal/snapshot-id.ts`) — monotonic, branded `SnapshotId` per strategy instance. The id is the load-bearing identity tag for `(input, output)` pairs.
- **Worker bundling** — `src/worker.ts` is bundled to a single ESM string by `scripts/build.mjs` and injected into the main bundle via esbuild's `define: { __WORKER_SOURCE__: ... }`. Runtime: `spawnWorker()` constructs a `Worker` from a Blob URL. Adopters in CSP-restricted environments override via `workerFactory: () => Worker`.
- **Compute transport** — the user's `compute` function travels across `postMessage` as `compute.toString()`; the worker reconstructs via `new Function("inputs", "signal", "return (${source})(inputs, signal);")`. The first arg `inputs` is a wrapper object `{ streaming, intent }` so the consumer's compute function destructures the two kinds explicitly. The hook deduplicates by source string so inline arrows with identical bodies don't re-trigger.

### Substrate invariants (verified by property tests)

1. `isComputing` ↔ `computingSnapshotId` is defined.
2. `data` defined ↔ `dataSnapshotId` defined; the pair is committed atomically (no rendered frame pairs `data` from snapshot N with `dataSnapshotId` from snapshot N±k).
3. `dataSnapshotId` is monotonically increasing across emitted commits.
4. Streaming-only changes during in-flight compute do not cancel; the in-flight completes against its tagged snapshot.
5. Intent changes during in-flight compute cancel-and-restart; the new compute runs against the latest (streaming, intent) pair.
6. `destroy()` produces no further notifications.
7. `worker.terminate()` is called exactly once per `destroy()` (idempotent).
8. Random sequences of `setInputs / cancel / destroy / wait` survive without throwing — including post-destroy ops which are silent no-ops.

### Worker error semantics

The bridge subscribes to `error` and `messageerror` on the worker. Both surface as a `WorkerCrashResponse` (a member of `WorkerOutbound`) which strategies treat as **terminal**:

- in-flight compute fails (`error` set, `isComputing: false`)
- pending streaming-only update drops
- last-good `data` and `dataSnapshotId` are preserved
- subsequent `setInputs` is a no-op (the worker process is dead — there's nothing to send to)
- the consumer must unmount and remount to recover

`productionRunner` rejects function sources containing `[native code]` (bound functions, native functions, host-provided functions) before passing them to `new Function`, so adopters get a clear error instead of a syntax-valid-but-runtime-broken closure.

### Compute reconstruction caching

`createProductionRunner()` returns a runner with a per-source `Function` cache. At React's 60 Hz cadence with stable compute, this turns up to 60 `new Function` invocations per second into 1 (per unique source). The cache lives for the worker's lifetime — new workers (Strict Mode remount, post-crash remount) start fresh.

### Subscriber-notification semantics

Strategies and `StrategyHandle` iterate a **snapshot** of the listener set during notification (`for (const listener of [...this.listeners])`). This makes mid-notify modifications safe:

- A listener that unsubscribes itself: still fires for this delivery; absent on the next.
- A listener that unsubscribes another: the other still fires for this delivery (was in the snapshot); absent on the next.
- A listener that subscribes a new one: the new listener does **not** fire on this delivery; starts on the next.
- A listener that triggers a synchronous state change (e.g. calls `cancel()`): the recursive notify iterates a fresh snapshot. Bounded by the listener's own re-entry guard — adopters writing such listeners must avoid unbounded recursion.

This matches the React idiom of "subscribe on commit, observe on next change". Verified in `test/subscriber-race.test.ts`.

### React lifecycle specifics

- **Strict Mode double-mount**: each effect setup creates a fresh strategy + worker; cleanup destroys the previous. Verified by a Strict-Mode-wrapped render test that asserts `terminateCalls.length === workerCount`.
- **SSR**: `useSyncExternalStore`'s `getServerSnapshot` returns the initial state (`data: undefined`, `isComputing: false`, all snapshot ids `undefined`). No worker is created on the server.
- **Inputs identity**: hook tracks `options.streaming` and `options.intent` independently by reference. For the raw-value path, adopters memoise object literals (or pass primitives); for the `Source<T>` path, identity is whatever the source's `getSnapshot()` returns and the substrate consumes via subscription rather than identity comparison. Compute closures are deduplicated by source string, so inline arrows are fine.

## Test layout convention

Tests live in `packages/coherent-derivation/test/`, **not** colocated with source. Decided in the post-Phase-1 evaluation. Three load-bearing reasons:

1. **Tarball cleanliness without build glue.** The library publishes `src/**/*.ts` to npm so adopters' bundlers can resolve sourcemaps to readable code. Colocated `*.test.ts` files would either land in the published tarball (bloat plus exposes test scaffolding to consumers) or require explicit `!src/**/*.test.ts` negations in the `files` field — one more invariant to keep in sync.
2. **Source listing is library-only.** `ls src/` answers "what is this library", not "what does it test". When a senior reviewer scans the repo, the public surface is unmuddled.
3. **Test utilities sit naturally in `test/utils/`.** `FakeWorker`, `asWorker`, `computeRequest` colocate with the tests they support rather than next to runtime code.

Vitest's config supports both layouts equally well. The choice is a project convention, not a tooling-generation marker; colocation is widely used in modern Vitest/Bun/Deno setups too. We picked separate specifically because we publish to npm.

## SVI fitter (Phase 2)

Demo-internal calibration engine in `demo/src/svi/`. The fitter is the demo's reference compute, not a library primitive — the demo's worker module wires it as the substrate's compute under `useCoherentDerivation` via `workerFactory`. The fitter includes `fitSviSliceWithCalendarFloor` (soft-penalty floor) and `repairCalendarArb` (iterative, dense floor) to support production-realistic surface scaling.

**Parametric form (Gatheral & Jacquier 2014).** Per-slice raw-SVI: `w(k) = a + b·(ρ·(k − m) + √((k − m)² + σ²))` in log-moneyness `k = log(K/F)` with `w = IV² · T`. SSVI / SVI-JW / multi-slice joint calibration deferred to post-v1.

**Constraints.** `b ≥ 0`, `|ρ| ≤ 1`, `σ > 0`, level coupling `a + b·σ·√(1 − ρ²) ≥ 0`. Branded `SviParams` minted only by `validateParams`; the level floor is computed via `(1 − ρ)·(1 + ρ)` to stay numerically stable as `|ρ| → 1`.

**Reparametrisation.** LM operates on unconstrained `u = (a, b̃, ρ̃, m, σ̃)` with `b = softplus(b̃)`, `ρ = tanh(ρ̃)`, `σ = softplus(σ̃)` — eliminates bias as `|ρ| → 1` that clipping would introduce. Level coupling enforced as a soft quadratic penalty appended to the residual vector. Chain-rule multipliers expressed in terms of the constrained parameter (`db/db̃ = 1 − e^{−b}`, `dρ/dρ̃ = 1 − ρ²`, `dσ/dσ̃ = 1 − e^{−σ}`) rather than the unconstrained, for numerical robustness at large `b̃` / `σ̃`.

**Generic Levenberg-Marquardt** (`lm-solver.ts`). SVI-free; takes `f(p)`, `J(p)` callbacks. Marquardt's scale-invariant diagonal damping `(JᵀJ + λ·diag(JᵀJ)) δ = −Jᵀr` (the equivalent λ·I form fails on multi-scale problems — NIST Misra1a's `JᵀJ` diagonal spans ≈10¹¹). Damping update: λ ← λ/2 on accept, λ ← λ × 10 on reject (Marquardt 1963; MNT 2004). Three convergence criteria recorded in result: gradient `‖Jᵀr‖∞ < gradTol·(1 + ‖p‖)`, step `‖δ‖ < stepTol·(1 + ‖p‖)`, max iterations 100. Cholesky linear solve with floored diagonal for rank-deficient inputs.

**Zeliade initial guess** (`initial-guess.ts`). Outer 2-D grid over `(m, σ)`: main grid `m ∈ [−0.5, 0.5]` step 0.05 × `σ ∈ [0.01, 1.0]` log-spaced 12 points (231 candidates); fallback grid `m ∈ [−1, 1]` × `σ ∈ [0.001, 2]` log-spaced 20 points. For fixed `(m, σ)` the SVI form is linear in `(α, β, γ) = (a, b·ρ, b)`, solved via 3×3 normal equations with tiny ridge regularisation; cone projection enforces `γ ≥ 0`, `|β| ≤ γ`, level floor. No RNG — deterministic across runs.

**Failure-mode taxonomy.** Discriminated-union `FitResult`:

| Reason                 | Trigger                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `invalid-input`        | non-finite / non-positive `T`, `IV`, `k`, or `weight`                      |
| `underdetermined`      | < 3 quotes (5-param fit needs at least 5 d.o.f.; 3 is the practical floor) |
| `no-convergence`       | both grid scans yield no feasible candidate, OR LM hits iteration cap      |
| `constraint-violation` | back-transformed final params fail `validateParams`                        |
| `numerical-failure`    | residual / Jacobian non-finite; linear solve runaway                       |

**Output-side no-arbitrage** (`no-arb.ts`). `butterflyCheck(params, kGrid)` evaluates Gatheral's `g(k) = (1 − k·w'/(2w))² − (w'/4)·(1/w + 1/4) + w''/2`; reports `minG`, `minGAtK`, violation count, and first violating `k`. `calendarCheck(slices, kGrid)` verifies `w(k, T_{i+1}) ≥ w(k, T_i)` consecutively; reports `minDelta` and per-violation `(slice-pair, k)` tuples.

**Performance** (M-series Mac, vitest bench):

| Scenario              | p99     |
| --------------------- | ------- |
| 10-strike fit         | 0.17 ms |
| 50-strike fit         | 0.52 ms |
| 200-strike fit        | 1.85 ms |
| Full surface (50 × 6) | 2.81 ms |

CI gate (`demo/test/svi-perf.test.ts`) uses coarse budgets to absorb noise — ~3× for the smaller workloads, ~10× for the load-bearing 70×200 surface (sized for GitHub Actions `ubuntu-latest` variance). `demo/bench/svi.bench.ts` is the authoritative baseline.

**scipy cross-validation.** `demo/tools/generate-scipy-reference.py` (pinned `scipy==1.13.0`) regenerates `demo/test/fixtures/scipy-reference.json`. CI does not run Python; reviewers re-run the script locally to verify the snapshot.

## Demo

Demo lives under `demo/`. Vite + React 19 + Tailwind v4 in financial-domain register: JetBrains Mono / Inter, slate / OKLCH palette, tabular-nums, dense layout.

### Worker integration via `workerFactory`

The library reconstructs `compute` via `new Function(source)`, which has no module resolution; the SVI fitter is too large to cross as a stringified closure. The demo bundles `demo/src/worker/svi-worker.ts` containing the fitter directly and passes a `workerFactory` to `useCoherentDerivation`. The custom worker (surface-aware):

- Listens for `WorkerInbound` messages (typed via `import type { WorkerInbound, WorkerOutbound } from "@oracaus/coherent-derivation"` — the protocol is exported and semver-stable from v0.5.0).
- Ignores `inbound.source` (the stringified compute) and dispatches directly to `computeSurface` in `demo/src/worker/compute-surface.ts` — extracted from the worker handler so it's directly testable.
- Receives a full-surface `DemoSurfaceInput` (`slices`, `trueParamsPerSlice`, `tickIndex`); calls `fitSviSlice` per slice; runs `repairCalendarArb` over a 200-point k-grid; emits a `DemoSurfaceOutput` (`perMaturity: SlicedFitResult[]`, `surfaceArbStatus`, `sourceTickIndex`, `computeMs`).
- `surfaceArbStatus` is `arb-free` / `repair-applied` / `repair-failed` / `arb-violation` (the latter fires when `repairMode = "off"` and the check-only pass detects violations — user-elected risk, not a failure). Emit policy is **unconditional** (status is for instrumentation, not suppression). The Panel's chip rail surfaces it.
- `computeMs` is measured around the full surface compute, so the Panel's `compute: NN ms` metric reflects true per-tick worker latency.

Adopters with similar non-trivial-compute needs follow the same pattern; documented in `demo/README.md` and the library's README.

### Two-panel demo architecture

Both panels run their OWN worker instance (each `useCoherentDerivation` mounts its own per the library's design). The fits land independently. The difference is React-side:

- **NAIVE** (`useNaiveFit`): post-on-every-tick to its worker; returns `{ data, isComputing, pendingCount }` only. The "latest input view" the panel displays is **not** held in `useNaiveFit` — it's sourced from `feed.tick` directly via `App.tsx`'s `naiveDisplayInputs` projection. So the displayed `(dots, curve)` pair is `(feed.tick → projection, naive.data.fitResult)` — two independently-updating views (`feed.tick` is 5 Hz throttled; `naive.data` is eagerly set on every worker result). When the fit lags the feed or runs ahead of it, dots and curve are from different snapshots → tearing visible at every strike that disagrees beyond noise floor. **Queue saturation cap** (`MAX_PENDING_QUEUE = 20`) bounds the worker's inbound message backlog — production naive systems either drop or block when the consumer can't keep up; this demo drops, surfaced by the `queue: 20` chip.
- **GATED** (`useGatedFit` → `useCoherentDerivation`): the library holds visible state during in-flight compute and commits `(input, output)` atomically. Dots come from `data.sourceSlice` (echoed back per maturity); curve comes from `data.fitResult.params`; both are guaranteed coherent. The library's streaming strategy conflates inputs internally — no queue growth.

### Display state pipeline — single 5 Hz clock

Every consumer downstream of `App.tsx` (Panel, OptionChainTable, MismarkSparkline) reads state through a `useThrottled` boundary at `DISPLAY_REFRESH_INTERVAL_MS = 200` ms. Per-panel props are bundled into a composite via `useMemo` and the composite is throttled — so the chart, stats ribbon, status chips, and mismark metric all reflect the same instant (no flicker from chart updating at 13 Hz while stats update at 5 Hz). `currentTickIndex` is part of the composite so the lag metric and the chart data flush on the same boundary.

**Single source of truth for "current displayed tick"**. `feed.tick` (5 Hz throttled in `useFeed`) is the canonical view; both the lag chip's `currentTickIndex` prop AND the naive panel's "latest input view" derive from it. `useNaiveFit` does **not** maintain its own `latestInputs` React-state slot — `naiveDisplayInputs` in `App.tsx` is computed by projecting `feed.tick` directly. Earlier the demo had two independent 5 Hz `setInterval`s (one in `useFeed`, one in `useNaiveFit`) that drifted antiphased by ~200 ms in practice; this produced a `latestInputs.tickIndex ≠ feed.tick.tickIndex` race that made the lag metric and the visible-tear diagnostic reference different sources. See `DEMO_METRIC_FIX_PLAN.md` for the full root-cause analysis.

Three rates internally:

- **Feed tick rate** (50–500 Hz, user-controllable): synthetic option-chain refit cadence.
- **Worker compute rate** (~12 Hz at default 70 × 200 / 75 ms): how fast a single surface fit completes.
- **Display refresh** (5 Hz): how often React commits flow to consumers. Matches trading-desk display-throttle cadence (CLAUDE.md mini-series §The three rates).

Render-performance memoisation: `Panel`, `Smile`, `MismarkSparkline`, `OptionChainTable` are all `React.memo`'d so reference-stable throttled props don't cause re-renders below the 5 Hz boundary. SVG paths in `Smile` are `useMemo`'d on params+scales — `buildCurvePath` does not re-run when the 100-sample path data hasn't changed.

### Synthetic feed

`demo/src/feed.ts:SyntheticFeed`. Deterministic mulberry32 PRNG drives:

- GBM spot evolution (`r = 0.05`, `σ = 0.20`, `Δt = 1/(252·50)` years per tick)
- One **global** Ornstein-Uhlenbeck walk on `(a*, b*, ρ*, m*, σ*)` anchored on SPX-style values (`a* = 0.04`, `b* = 0.1`, `ρ* = -0.5`, `m* = 0`, `σ* = 0.2`).
- Per-slice params derived as `a_T = a* · T` with `b, ρ, m, σ` shared across maturities. The deterministic T-scaling on `a` makes the TRUE underlying surface calendar-arb-free at every k (slice i+1's variance exceeds slice i's by `a*·(T_{i+1} − T_i)` everywhere). Parameter clamps + level-constraint re-validation enforce raw-SVI feasibility each tick.
- Per-(strike, maturity) observed IV: `√(w(k, params_T) / T) + Gaussian noise` (default `ivNoise = 0.001` — 10 bps, SPX-ATM-realistic; was 0.005 pre-3.5 evaluation, which drove 100 % repair-failed at 70 × 200).

The TRUE surface is arb-free by construction; per-(k, T) IV noise on observed quotes produces per-slice fits that occasionally violate the calendar bound — that's exactly the noise-induced regime `repairCalendarArb` is designed for.

Vol-shock multiplier amplifies σ_spot and the OU diffusion × 5 for a 10-second burst. URL params `?seed=<int>`, `?mode=recording` for reproducible takes.

### Surface dimensions + control surface

Default: **70 expiries × 200 strikes per slice** — 75 ms p99 warm on M-series Mac, middle of the Form 2 zone [50, 150] ms. The expiry count is user-selectable via a stepped button group in `Controls.tsx` from `{12, 30, 50, 70, 80}` — the production-meaningful axis. Each step's tooltip shows the estimated p99 compute so the viewer can predict their Form 2 zone position without consulting the bench documentation. (Earlier the set started at 6; dropped because at six exponentially-spaced points the `1Y` and `2Y` display-tenor selectors both collapsed onto the same ladder entry, making them a visual no-op. 12 is the smallest count where all five display tenors land on distinct entries.)

A second stepped selector (`{1M, 3M, 6M, 1Y, 2Y}`) chooses which slice both panels render. Display-maturity selection is a top-bar global control — the comparison demands both panels on the same tenor. The displayed slice index is derived via `findClosestMaturityIdx(buildExpiryLadder(nExpiriesFitted), displayMaturityYears)` so the selection survives expiry-count changes.

### Calendar-arb repair pipeline

`computeSurface` runs `fitSviSlice` per slice, then `repairCalendarArb(slices, fitResults, kGrid)` from `demo/src/svi/no-arb.ts`:

1. **Detect** calendar violations via the existing `calendarCheck` on a 200-point k-grid.
2. **Iterate** up to `MAX_REPAIR_ITERATIONS = 8` rounds: each round identifies violating slices and re-fits with `fitSviSliceWithCalendarFloor` using a **dense floor on the full k-grid** (matching floor density to check density — sparse floors let the LM dip between floor points and create new violations).
3. **Cap** cumulative re-fits at `maxRepairsPerPass(nSlices) = min(30, max(10, ceil(nSlices × 0.3)))` — scales with surface size; 21 for the 70-slice default, 10 for ≤ 33 slices (preserves the structural-problem test case's semantics).
4. **Soft-penalty calibration**: floor weight `1000` (10× the plan's 100; empirical equilibrium analysis), over-floor margin `1 × 10⁻⁷` (belt-and-braces), LM `maxIterations: 200` for the floor-constrained fit (cuts refit-failure ~40 % vs default 100).
5. **Failure modes** distinguished on `RepairResult.failureReason`: `pre-existing-fit-failure` / `too-many-violations` / `refit-failure` / `residual-violations`.

Empirical 70 × 200 distribution at the default σ_iv = 0.001 (5 seeds × 30 ticks): **69 % arb-free, 27 % repair-applied, 4.7 % repair-failed**.

### Two-metric verification UI per panel

- **In-panel coherence error**: `Σ_i |w_fit(k_i, params) − w_obs_i| / N`. What the library fixes. NAIVE under shock: large. GATED: at LM-residual scale.
- **Ground-truth tracking error**: `||fitted_params − source_true_params||` normalised. What neither library can prevent (lag is intrinsic). Both panels: similar magnitude.

Showing both makes the demo's correctness claim falsifiable on screen.

**Per-mode lag formula** (`demo/src/metrics.ts` — `computeSnapshotLag`). The two panels carry different coherence guarantees, so "lag" means different things on each:

- **NAIVE: `abs(latestInputs.tickIndex − data.sourceTickIndex)`.** The displayed `(dots, curve)` pair lives in independent state slots that can come from different ticks; the lag chip reports the *absolute* structural gap. Both directions matter — at heavy load the queue saturates and `data` lags `latestInputs`; at light load the eager `setData` runs ahead of the 5 Hz throttled input view and `data > latestInputs`. The mismark and red-dot diagnostics derive from the same `(latestInputs, data)` pair, so the chip's magnitude tracks what the chart shows by construction.
- **GATED: `max(0, currentTickIndex − data.sourceTickIndex)`.** The substrate's atomic commit makes `(latestInputs.tickIndex === data.sourceTickIndex)` identically — there's no dots-vs-curve tear by construction. The meaningful lag is staleness of the coherent snapshot relative to the feed's latest tick (`max(0, ...)` because the substrate cannot commit a fit ahead of its own source tick).

The two formulas use a `switch` + `assertNever(mode)` in a single helper so a future third panel mode would type-error rather than silently fall through.

**Chip semantics — mismark-driven for both modes**. The `COHERENT`/`STALE` header chip is computed from `stickyCoherent` (mismark-with-hysteresis) only, on both panels. It annotates the *visible* tear directly — chart-and-chip agree by construction. The lag metric number has its own red/green tone via `stickyLagStale` with widened thresholds (`LAG_STALE_ENTER_TICKS = 10`, `LAG_OK_RETURN_TICKS = 3`) so the lag-tone calibration matches the post-fix-formula envelope rather than the pre-fix (clamped-to-zero) one.

Earlier the chip OR-combined lag and mismark on naive — but that was downstream of a lag formula that lied (clamped negative results to zero). With the honest formula the naive lag naturally fluctuates 1–9 ticks at Scenario 0 from the 5 Hz throttle staleness; that's fine for a structural number but it would make the chip flicker at 1 Hz. Decoupling chip (visible tear) from lag (structural number) aligns each signal with what a trader expects: chip says STALE when the chart looks torn, lag number reports magnitude of the structural skew. Two independent diagnostics, both honest.

Regression tests in `demo/test/metric-coherence.test.ts` lock in both formulas and the source-identity invariant (no inline duplication of the lag math in Panel.tsx or App.tsx).

### Cross-view hover overlay

Hover anywhere in the demo — either smile or any option-chain row — and a synchronised diagnostic overlay lights up across all three views simultaneously. Demonstrates the article's "keep downstream stages synchronous" pattern (piece 4 §The Substrate Isn't): the substrate's atomic emit is the alignment point; the per-point overlay is a render-body `useMemo` against it, coherent via React's atomic commit without a second substrate.

**State shape.** A single `hoveredK: number | null` in `App.tsx`, owned outside the 5 Hz `useThrottled` boundary so hover feels immediate. Threaded to both `Panel`s and `OptionChainTable` as `(hoveredK, onHoverChange)` props. Pointer-move on either smile and `onPointerEnter` on any chain row set the value; `onPointerLeave` on the SVG / `<tbody>` clears it. Persisted across `displayMaturityYears` changes — the visual cursor stays at the same k on the new smile, letting viewers compare diagnostics across tenors by hovering then switching slice.

**Cursor stroke colour reinforces panel identity.** Red (`--color-accent-stale`) on NAIVE, green (`--color-accent-ok`) on GATED — same hues as the panel header chip rail. `cursorTone: "stale" | "ok"` flows from `App → Panel → Smile`; constants inlined in `Smile.tsx` (`CURSOR_STROKE_STALE` / `CURSOR_STROKE_OK`) so the SVG attribute path skips CSS-var lookups per frame. The line itself stays a thin dashed mark; only the stroke colour differs.

**Tooltip is HTML + backdrop-blur, not SVG.** `backdrop-filter` doesn't apply to SVG elements in current browsers (`BackgroundImage` was dropped from Chromium). The overlay lives as an absolutely-positioned HTML `<div>` sibling of the SVG inside a `position: relative` wrapper. Visual effects are compositor-only: `bg-bg-elev/70` (alpha-channel composition) + `backdrop-blur-md` (`backdrop-filter: blur(12px)`). Pointer handlers attach to the wrapper, not the SVG; the overlay uses `pointer-events: none` so events tunnel through to the wrapper, where the bounding rect (identical to the SVG's) drives the x → k inversion.

**Overlay content** (five lines, pinned top-left of each smile):

| Line  | Value                                                                  | Source                                                                                          |
| ----- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `k`   | hovered log-moneyness                                                  | `hoveredK`                                                                                      |
| `IV fit` | `√(w(hoveredK, fittedParams) / T)`                                  | panel's `data.fitResult.params` (substrate-emitted for GATED; whatever-fit-landed for NAIVE)    |
| `IV obs` | nearest quote's IV within ±0.02 in k                                | panel's dots slice (`data.sourceSlice` for GATED; `latestInputs.slice` for NAIVE)               |
| `miss`   | `IV fit − IV obs`                                                  | combination of the two above                                                                    |
| `g(k)`   | `gatheralG(hoveredK, fittedParams)` butterfly indicator            | `demo/src/svi/diagnostics.ts` (re-export from `no-arb.ts`)                                      |

**The demo signal.** In GATED, `fit` and `obs` both come from the substrate's emit (same snapshot) — `miss` sits at LM-residual scale. In NAIVE, `fit` comes from `data` (snapshot N−k) and `obs` from `latestInputs` (snapshot N); under shock `miss` blows up at the hovered k. Same Form 2 failure as the (dots, curve) tear, now expressed as a number at a chosen point. Third axis of coherence on display: the chain row's `k` (a discrete strike), the dashed cursor on both smiles, and the per-k overlay numerics all agree-or-disagree based on snapshot pairing.

**Coherence rationale.** `useMemo` over `(hoveredK, fittedParams, quotes, timeToExpiry)` inside `Smile.tsx`. Two of the deps (`fittedParams`, `quotes`) come from the panel's substrate-emitted `data` (GATED) or `latestInputs` (NAIVE) — already 5 Hz-throttled at the App boundary. `hoveredK` is direct user input. The overlay re-derives per pointer event without the substrate; React's atomic commit pairs the overlay with the underlying dots and curve.

**Tolerance choice.** ±0.02 in k for both the overlay's nearest-quote lookup (in `Smile.tsx`) and the chain-row highlight (in `OptionChainTable.tsx`). At 200 strikes over [−1, 1] the inter-strike step is ≈0.01 in k; ±0.02 covers two strike widths. The two tolerances are the same constant in spirit (`NEAREST_QUOTE_K_TOLERANCE` / `NEAREST_ROW_K_TOLERANCE`) so the highlighted row visibly tracks the smile cursor at exactly the same threshold the overlay uses to resolve `IV obs`.

**Pure-functions module.** `demo/src/svi/diagnostics.ts` exposes `kDerivatives(k, params)` (analytical first and second derivatives of `w` in `k`, validated by central-difference tests in `svi-diagnostics.test.ts`) and re-exports `gatheralG`. Skew and convexity are not currently surfaced in the overlay (left to a future iteration) but the module exists for one-import consumption.

### Viewport-too-small notice

The demo renders unconditionally at viewport sizes below `1280 × 700`. When the viewport is too small, `<ViewportNotice />` renders as a **fixed backdrop-blur overlay** on top of the (clipped) running demo — `bg-black/30 backdrop-blur-md` over the page, with an inner translucent card (`bg-bg-elev/75 backdrop-blur-sm`). The user sees the failure mode and the message together rather than a blanked screen; resizing makes the notice disappear without reloading. Compositor-only: alpha composition + `backdrop-filter: blur(...)`.

### Plotting

Hand-rolled SVG (`demo/src/components/Smile.tsx`, ~770 lines). `d3-scale` (~5 KB gz) for tick math + linear scales. No charting library; rationale lives in `Smile.tsx`'s module header. Memoised at the export so the Panel's compute-cadence re-renders don't re-render the SVG subtree.

**Adaptive y-axis per maturity, with hysteresis + compositor-only transitions.** Three-stage pipeline:

1. **Anchor baseline** (`App.tsx:computeSmileYRange(T, xRange)`). Derives the IV range from the synthetic feed's anchor parameters at the displayed maturity. At 1M (T ≈ 1/12) the SVI smile's ATM IV scales roughly as `√(b·σ/T)`, pushing wings to ~1.4; at 1Y the smile fits cleanly in [0.21, 0.47]. Recomputed only on `displayMaturityT` change. Anchor params mirrored from `feed.ts` rather than imported — keeps `App.tsx` independent of `SyntheticFeed`'s internals.
2. **Sticky range with expand-only hysteresis** (`App.tsx:stickyYRange`). Starts at the anchor and **expands outward** when the observed IV envelope (unioned across both panels' currently-rendered slices, ~2 000 number comparisons / sec) overflows. Never shrinks within a maturity selection — avoids axis-tick jiggling that would otherwise fire every 5 Hz throttle flush as the OU walk perturbs IVs. Reset to the anchor on maturity change.
3. **Compositor-only y-axis transition via Web Animations API** (`Smile.tsx` `useLayoutEffect` on yRange change). When `yRange` changes, Smile re-renders content positions at the NEW range immediately, then runs a WAAPI animation on the inner chart group via `element.animate([fromKeyframe, toKeyframe], options)`. The `from` keyframe is a transform that visually maps new positions back to where the same data lived under the OLD range; the `to` keyframe is identity. The interpolation runs on the GPU compositor — zero React re-renders, zero main-thread style/layout/paint per animation frame, **and no force reflow** (which the earlier CSS-transition approach required to commit the initial transform before transitioning, and which DevTools flagged in the Performance Insights panel). The animation appears in DevTools' Animations panel, making the compositor-only behaviour verifiable at a glance. Math: `sy = (newMax − newMin) / (oldMax − oldMin)`, `ty = MARGIN.top × (1 − sy) + innerH × (oldMax − newMax) / (oldMax − oldMin)`. Applied around `transform-origin: 0 0` with `transform-box: view-box` (the SVG default for non-root `<g>`); the `MARGIN.top × (1 − sy)` term compensates for the parent's `transform="translate(MARGIN.left, MARGIN.top)"` so the math behaves identically to the previous `fill-box` setup. Using `view-box` is load-bearing for steady-state perf — `fill-box` would force the browser to recompute the element's bounding box every time its inner content changes (200 circles × 2 panels per 5 Hz tick), which triggered unattributed document-wide reflows in earlier traces. The animation handle is stored in a ref so a new yRange change while a previous animation is in flight can cancel the in-flight (interruption case is rare for user-button-triggered maturity changes but correct). Respects `prefers-reduced-motion: reduce` by setting `duration: 0` — the animation is a visual aid, not load-bearing for comprehension.
4. **ClipPath on the chart interior** (`Smile.tsx:clipId`) confines dots, curve, and hover cursor to the inner chart rectangle so they don't bleed above/below during transitions or when out-of-domain IVs briefly appear before sticky catches up. Unique per-instance id via `useId()` (colons stripped for the widest browser support).

**Replaced** the earlier rAF-driven `useAnimatedRange` hook which cost ~50 ms of main-thread work over each 300 ms transition (~18 React re-renders per panel, each rebuilding scales + paths). The intermediate CSS-transition approach (with imperative `style.transform` + `void getBoundingClientRect()` to force a style flush) was cleaner per-frame but tripped DevTools' "Forced reflow" detection. The current WAAPI implementation is the cleanest: no reflow, no two-step style manipulation, compositor-accelerated for transform animations in Chromium 84+ / Firefox 75+ / Safari 13.1+ (all within the demo's stated browser support). Cost per transition: a single `element.animate()` call (~1 ms). Shape distortion during scaleY is the trade — dots stretch into ovals during the transition, returning to circles at identity. This is the visual idiom every chart library uses for the same transition and matches the "y-axis zoom" mental model.

### Deployment

`.github/workflows/deploy-demo.yml`. Path-filtered to `demo/**` + `packages/coherent-derivation/**`. Builds library + typechecks + builds demo via Vite + uploads via `actions/upload-pages-artifact` + deploys via `actions/deploy-pages`. Pages source is "GitHub Actions" (no `gh-pages` branch). Custom domain `demo.oracaus.dev` is held by `demo/public/CNAME` (Vite copies `public/*` into `dist/*` verbatim, so the CNAME survives every deploy). Vite `base: "/"` for both build and dev — assets resolve at the subdomain root. The legacy `oracaus.github.io/oracaus/` URL continues to serve via GitHub's automatic 301 redirect to the custom domain once Pages settings recognise the CNAME. No `.nojekyll` needed — the Actions-based deploy path (`actions/deploy-pages@v4`) doesn't run Jekyll on artefacts; the file would be cargo-culting.

### Browser support

Module workers (`{ type: "module" }`) required. Chrome 80+, Firefox 114+, Safari 15+ (all "latest stable" qualify; ≥2 years old). Older browsers see a graceful "module workers required" notice.

### Bundle

| Chunk       | Raw    | Gz      |
| ----------- | ------ | ------- |
| App (index) | 288 KB | 92 KB   |
| SVI worker  | 15 KB  | ~5 KB   |
| CSS         | 24 KB  | ~5 KB   |
| Total demo  | 327 KB | ~102 KB |

Budget <250 KB gz; clearance ~148 KB. App grew ~7 KB raw / ~2 KB gz from the cross-view hover overlay (Smile pointer handlers + HTML overlay, OptionChainTable row hover, diagnostics module) plus the adaptive y-axis pipeline (`useAnimatedRange` hook, envelope detection, sticky range, ClipPath). CSS grew with Tailwind's `backdrop-blur-*` classes for the hover overlay and viewport-notice overlay.

### Deferred: transferable worker protocol

The current build ships with structured-clone postMessage at ~250 KB per surface message. The queue-saturation cap (`MAX_PENDING_QUEUE = 20` in `useNaiveFit`) bounds the OOM risk inherent to NAIVE's post-on-every-tick semantics. The production-quality follow-up is a **transferable `ArrayBuffer` worker protocol** — pack the surface into one Float64Array and `postMessage(buffer, [buffer])` for zero-copy transfer. Removes per-send clone cost but does not remove the need for the cap (worker heap has limits too). Deferred for scope reasons; the cap alone is sufficient for the v0.5.0 demo.

## Test suite

569 tests pass across the library and the demo (2 self-skipped gated on `--expose-gc`; run via `npm run test:memory`). Tests live per package: `packages/coherent-derivation/test/` for the library, `demo/test/` for the SVI fitter and surface scaling — see the test-layout convention section above.

Demo test files (all in `demo/test/`):

| File                                     | Tests | What it covers                                                                                                                                                                              |
| ---------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `svi-calendar-repair.test.ts`            | 4     | Calendar-arb repair: no-op on arb-free; noise-scale violation cleared; > MAX violations trips too-many; pre-existing-fit-failure                                                            |
| `feed-surface.test.ts`                   | 8     | Synthetic-feed surface: 70×200 default; ladder + grid shape; calendar-arb-free TRUE surface across 100 ticks; recovery within 5 %; recovery survives repair; determinism; shock             |
| `worker-integration.test.ts`             | 6     | Step D: perMaturity 1:1 with input slices; atomic-emit identity preservation; arb-status enum coverage; computeMs wired; empty-surface placeholder; 70×200 production-scale foundation gate |
| `svi-calendar-repair-properties.test.ts` | 2     | Step E: 200 randomised violation patterns satisfy contract; repair-applied surfaces byte-identical-arb-free under independent re-check                                                      |
| `svi-diagnostics.test.ts`                | 7     | Hover-overlay diagnostics: `kDerivatives` first/second derivative match central differences across fixtures; convexity strictly positive; left/right asymptotic slopes; `gatheralG` smoke   |
| `metric-coherence.test.ts`               | 10    | Per-mode lag formula (`abs(M-D)` for naive; `max(0, N-D)` for gated); coherence invariant — naive lag non-zero whenever the displayed (latestInputs, data) pair disagrees in tick; source-identity locks that Panel.tsx and App.tsx delegate to `computeSnapshotLag` |
| `projection-staleness.test.ts`           | 9     | Surface-snapshot projection rejects stale surfaces from a previous `nExpiriesFitted` setting; the `expectedSurfaceSize` guard prevents the brief post-resize window from rendering the wrong slice                                                              |

| File                               | What it covers                                                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker-loop.test.ts`              | Default echo runner; production runner via source; abort signal proxy; error path                                                                                                                                          |
| `worker-bridge.test.ts`            | Main-side round-trip via `FakeWorker`; terminate; abort responses ignored                                                                                                                                                  |
| `worker-error.test.ts`             | `error` and `messageerror` surface as terminal `WorkerCrashResponse`; `[native code]` detected                                                                                                                             |
| `production-runner.test.ts`        | Per-source `Function` cache: hit/miss, isolation across runner instances, error doesn't poison                                                                                                                             |
| `snapshot-id.test.ts`              | `SnapshotIssuer` monotonicity + uniqueness                                                                                                                                                                                 |
| `derivation-strategy-streaming.test.ts` | Strategy state machine — streaming-input scenarios: changes absorb (conflate into pendingTask + atomic commit on completion).                                                                                            |
| `derivation-strategy-intent.test.ts` | Strategy state machine — intent-input scenarios: changes cancel-and-restart in-flight against the new pair; mixed-input cancel-on-intent / absorb-on-streaming interleavings.                                              |
| `api-surface.test-d.ts`            | Type-level test (`.test-d.ts`) — hook generic inference, options/result types, worker-protocol re-exports.                                                                                                                 |
| `strategy-race.test.ts`            | Race interleavings: cancel/setInputs/destroy; post-destroy guards; rogue worker output                                                                                                                                     |
| `use-coherent-derivation.test.tsx` | React hook under happy-dom: initial render, recompute, Strict Mode, cancel, unmount                                                                                                                                        |
| `ssr.test.tsx`                     | `renderToString` produces initial-state shape; cancel callable as no-op                                                                                                                                                    |
| `strategy-properties.test.ts`      | `fast-check` invariants × randomised mixed-input scenarios. Properties: monotonic snapshot ids; atomic (data, dataSnapshotId) commits; streaming changes absorbed; intent changes cancel-restart; post-destroy ops silent. |
| `memory-baseline.test.ts`          | 10k mount/destroy + 10k setInputs/cancel cycles; heap-delta gated on `--expose-gc`                                                                                                                                         |
| `bundle-size.test.ts`              | Worker <3 KiB gz; main bundle <8 KiB gz (after minification)                                                                                                                                                               |
| `real-worker-integration.test.ts`  | End-to-end through a real `node:worker_threads.Worker` running the bundled worker source                                                                                                                                   |
| `compute-edge-cases.test.ts`       | Sync throw, sync return non-Promise, non-Error throws, closure-capturing compute, never-resolves                                                                                                                           |
| `subscriber-race.test.ts`          | Listener self/other-unsubscribe mid-notify; subscribe-during-notify; re-entrant cancel                                                                                                                                     |
| `hook-edge-cases.test.tsx`         | cancel-from-render, multiple hooks per tree, primitive inputs, factory-throws, streaming-only / intent-only / mixed shapes                                                                                                 |

Phase 2 SVI tests in `demo/test/`:

| File                           | What it covers                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `svi-form.test.ts`             | `w(k, params)` hand-computable values; `validateParams` reason-by-reason rejection; level-floor numerics                                                                                              |
| `svi-jacobian.test.ts`         | All 5 raw partials and 5 reparametrised partials vs. central differences across 1 000 random samples                                                                                                  |
| `lm-solver.test.ts`            | Linear LS to machine precision; Rosenbrock; NIST Misra1a (both starts); Lanczos1-style 6-param exp-sum                                                                                                |
| `svi-initial-guess.test.ts`    | Zeliade SPX recovery within 5 %; weighted LS sensitivity; underdetermined / length-mismatch failure modes                                                                                             |
| `svi-fitter.test.ts`           | Round-trip per-parameter recovery (`a`/`b`/`ρ`/`m`/`σ` 1e-4 / 1e-3 / 1e-3 / 1e-3 / 1e-4); IV fit ≤ 0.5 % rel; full invalid-input taxonomy                                                             |
| `svi-no-arb.test.ts`           | Gatheral `g(k)` arb-free SPX; constructed butterfly violations; calibrated vs extrapolated regimes                                                                                                    |
| `svi-calendar.test.ts`         | Multi-slice surface arb-free pass; swap-slice violation caught with `(k, T_i, T_{i+1})`; ordering guard                                                                                               |
| `svi-edge-cases.test.ts`       | NaN k / Infinity IV / single quote / collinear k / negative weight / subnormals / iteration-cap exhaustion                                                                                            |
| `svi-cross-validation.test.ts` | Recovery against two fixture pairs (`gatheral-spx.json`, `gatheral-skewed.json`) + paired scipy references within per-parameter tolerance                                                             |
| `svi-perf.test.ts`             | p99 + worst-case `max` latency gates for 10/50/200-strike fits + 50 × 6 full surface                                                                                                                  |
| `svi-properties.test.ts`       | Determinism (byte-identical outputs across re-fits); structural invariants under transform (scale / translation / idempotence); 30-run randomised scale-invariance sweep; calibrated-range diagnostic |

Commentary subsystem tests in `demo/test/commentary/` (11 files: `phase-reducer`, `scenarios`, `events`, `scheduler`, `phrase-sequencer`, `region`, `should-enqueue-insight`, `use-commentary`, `toolbar-commentary-toggle`, `CommentaryToast`, `CommentaryToastStack`). Each file targets a single subsystem of the live-narration engine (the phase machine + scenario settler + event detector + scheduler + phrase sequencer + region debouncer + polite-enqueue rule + hook integration + toolbar control + per-toast visuals).

`vitest.config.ts` has `passWithNoTests: true` as a leftover from an early state; can be removed on the next cleanup pass.

## Code conventions

- TypeScript strict mode; `noUncheckedIndexedAccess: true`; `exactOptionalPropertyTypes: true` per package
- Branded primitives for opaque values (Price, Quantity, Delta, etc. — see `packages/connection-layer/src/types.ts`)
- Discriminated unions with `assertNever` in default arms for exhaustiveness checks
- ESM only (`"type": "module"`)
- Imports include `.js` extensions in source for ESM correctness across builds

## Voice and conventions

When generating prose for this codebase (CHANGELOG entries, READMEs, articles, etc.):

- Peer-to-peer; senior engineers as the assumed reader
- Specific named scenarios with values, not abstract placeholders
- No marketing register ("exciting", "powerful", "unlock", "leverage", "supercharge")
- British English (organisation, optimised, behaviour, favour, centre)
- Honest about uncertainty and scope
- Don't tell readers what to think
