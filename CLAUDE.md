# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Oracaus — compute-quantum render alignment for heavy local compute against streaming inputs in React. v0.5.0 is the first release under this direction; the pre-pivot v0.4.0 (a per-stream causal-coherence library for trading UIs) is preserved in git history.

The architectural rationale for the v0.5.0 direction lives in the [pivot article](https://www.linkedin.com/pulse/pivot-narrowing-scope-substantive-screen-side-derivation-ka%C5%82ka-bexuf/); the formal substrate description (invariant, two input kinds, compositional positioning) lives in the [mini-series capstone](https://www.linkedin.com/pulse/anatomy-substrate-substantive-screen-side-derivation-przemys%C5%82aw-ka%C5%82ka-iklae/).

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
      types/build-globals.d.ts  # `declare const __WORKER_SOURCE__: string`
      internal/          # not exported; implementation
        worker-bootstrap.ts # spawnWorker — Blob URL from `__WORKER_SOURCE__`
        worker-protocol.ts  # WorkerInbound / WorkerOutbound discriminated unions
        worker-loop.ts      # WorkerLoop + ComputeRunner + productionRunner
        worker-bridge.ts    # main-thread WorkerLike adapter
        snapshot-id.ts      # SnapshotId branded type + SnapshotIssuer
        assert-never.ts     # exhaustiveness helper
        serialize-error.ts  # serializeError / deserializeError
        strategies/
          strategy-state.ts            # shared state shape + initialState
          derivation-strategy.ts       # single state machine: cancel on intent, absorb on streaming
    scripts/build.mjs    # tsc -b → esbuild worker → esbuild main with
                         # `__WORKER_SOURCE__` substitution
    test/                # tests live here, not colocated — see § Test layout convention
  connection-layer/      # workspace-internal; not published in v0.5.0
    src/                 # SharedWorker + BackpressureValve + ClientBridge +
                         # useTradingStream (per-stream only post-pivot)
demo/                    # the v0.5.0 demo (top-level; single demo, no apps/ wrapper)
  src/
    main.tsx             # the SVI vol-surface demo entry component
    svi/                 # Phase 2: per-slice raw-SVI calibration (demo's
                         # reference compute, not a library primitive)
      params.ts          # branded SviParams + validateParams + level floor
      svi.ts             # w(k, params); Slice + Quote types
      jacobian.ts        # 5 raw + 5 reparametrised partials with chain rule
      reparam.ts         # softplus / sigmoid / atanh ↔ tanh transforms
      lm-solver.ts       # generic Levenberg-Marquardt (no SVI knowledge)
      initial-guess.ts   # Zeliade 2-D outer grid + closed-form inner LS
      no-arb.ts          # Gatheral g(k) butterfly + calendar checks + repairCalendarArb
      fitter.ts          # composed pipeline + discriminated-union FitResult
      diagnostics.ts     # per-point hover-overlay diagnostics — analytical
                         # dw/dk and d²w/dk² in k; re-exports gatheralG
      index.ts           # demo-internal re-exports
    worker/
      svi-worker.ts      # bundled worker (workerFactory path); imports fitter directly
      compute-surface.ts # extracted compute fn, directly testable
  test/
    fixtures/
      gatheral-spx.json      # synthetic SVI calibration data + citation
      scipy-reference.json   # scipy cross-validation reference
    *.test.ts                # see § Test suite for breakdown
  bench/svi.bench.ts         # vitest bench (single + full surface)
  tools/                     # generate-scipy-reference.py (pinned 1.13.0); not in CI
  tsconfig.test.json         # mirrors coherent-derivation; included in npm run typecheck
```

## Locked API

Single primitive: `useCoherentDerivation<TStreaming, TIntent, TOutput>(options)`. Inputs are split into two named slots:

- `streaming` — changes do not cancel in-flight compute; the in-flight completes against its tagged snapshot, then the next compute kicks off against whichever streaming value is current at completion. Use for option-chain ticks, position updates, market-data feeds.
- `intent` — changes cancel the in-flight compute and restart against the newest value. Use for slider drags, parameter tweaks, mode selections.

Either or both can be supplied. Mixed UIs (streaming chain plus user-controlled fit parameters) are first-class; the substrate cancels on intent change and absorbs on streaming change automatically.

Both slots accept either a **raw value** or a **`Source<T>`** — a subscription-shaped value following `useSyncExternalStore`'s shape. Raw values fit low-rate inputs (sliders, mode toggles) and adopters whose feed already lands in React state. For high-rate streaming inputs (option chains at 50–500 ticks/sec, position updates, sensor streams), use **`useEventSource`** to bridge the feed into a `Source<T>`. The substrate subscribes once and consumes pushes through that subscription; the host component renders at substrate commit cadence rather than at input rate. Without the Source path, host re-renders fire per push and pre-coalesce inputs before the substrate sees them — defeating the streaming-input architecture's whole premise. `useCallbackSource` is the imperative sibling — returns `[Source, push]` for event-handler-driven flows.

A third option ("always-latest", no gate) was deliberately omitted — equivalent to "do not use this library for this case".

Full type surface: [`packages/coherent-derivation/src/types.ts`](./packages/coherent-derivation/src/types.ts).

## Status

v0.5.0 in development. Implementation complete (library + demo); pre-publish work tracked separately. v1.0.0 designation reserved for after a feedback period with real adopters.

The v0.4.0 RenderGate (cross-stream causal coherence) was stripped during the v0.5.0 baseline work; the surrounding connection layer (SharedWorker + BackpressureValve + BroadcastChannel + ClientBridge + useTradingStream) was kept and rewritten to drop the gate dependency. Per-stream messages now flow through unchanged; cross-stream alignment is the consumer's job (or the middle tier's).

## `@oracaus/coherent-derivation` package layout

The public API is `useCoherentDerivation<TStreaming, TIntent, TOutput>(options)`. The hook decomposes into:

- **`StrategyHandle`** (`src/use-coherent-derivation.ts`) — stable reactive store created once per component instance via `useState`. Owns the subscriber set + the snapshot read by `useSyncExternalStore`. Strategy attaches/detaches around it across Strict Mode's effect setup → cleanup → setup cycle without losing subscribers.
- **`CoherentDerivationStrategy`** (`src/internal/strategies/derivation-strategy.ts`) — single state machine. Tracks `lastStreamingRef` and `lastIntentRef` by identity; on `setInputs(streaming, intent, source)`:
  - Intent ref changed during in-flight compute: send `{ type: "abort" }`, drop any pending streaming-only update, start fresh compute against the new (streaming, intent) pair.
  - Streaming-only ref changed during in-flight compute: conflate into a single `pendingTask`; let the in-flight finish; kick off the pending task on completion.
  - No in-flight compute: start immediately.
  - Stale responses for superseded snapshot ids are dropped via `currentSnapshotId` mismatch.
- **`WorkerBridge`** (`src/internal/worker-bridge.ts`) — main-thread adapter over a `WorkerLike` (real `Worker` or `FakeWorker`). Stable subscribe/terminate.
- **`WorkerLoop`** (`src/internal/worker-loop.ts`) — worker-side dispatch. Each compute creates an `AbortController`; `abort` messages look up the controller. Result/error dropped if signal aborted before resolution.
- **`SnapshotIssuer`** (`src/internal/snapshot-id.ts`) — monotonic, branded `SnapshotId` per strategy instance. Load-bearing identity tag for `(input, output)` pairs.
- **Worker bundling** — `src/worker.ts` is bundled to a single ESM string by `scripts/build.mjs` and injected via esbuild's `define: { __WORKER_SOURCE__: ... }`. `spawnWorker()` constructs a `Worker` from a Blob URL. Adopters in CSP-restricted environments override via `workerFactory: () => Worker`.
- **Compute transport** — `compute.toString()` crosses `postMessage`; the worker reconstructs via `new Function("inputs", "signal", "return (${source})(inputs, signal);")`. `inputs` is `{ streaming, intent }` so consumers destructure explicitly. Hook deduplicates by source string so inline arrows with identical bodies don't re-trigger.

### Substrate invariants (verified by property tests)

1. `isComputing` ↔ `computingSnapshotId` is defined.
2. `data` defined ↔ `dataSnapshotId` defined; pair committed atomically.
3. `dataSnapshotId` is monotonically increasing across emitted commits.
4. Streaming-only changes during in-flight compute do not cancel; in-flight completes against its tagged snapshot.
5. Intent changes during in-flight compute cancel-and-restart; new compute runs against the latest (streaming, intent) pair.
6. `destroy()` produces no further notifications.
7. `worker.terminate()` is called exactly once per `destroy()` (idempotent).
8. Random sequences of `setInputs / cancel / destroy / wait` survive without throwing — including post-destroy ops as silent no-ops.

### Worker error semantics

`error` and `messageerror` on the worker both surface as a `WorkerCrashResponse` which strategies treat as **terminal**:

- in-flight compute fails (`error` set, `isComputing: false`)
- pending streaming-only update drops
- last-good `data` and `dataSnapshotId` are preserved
- subsequent `setInputs` is a no-op (worker process is dead)
- consumer must unmount and remount to recover

`productionRunner` rejects function sources containing `[native code]` (bound, native, or host-provided functions) before passing them to `new Function`, so adopters get a clear error instead of a syntax-valid-but-runtime-broken closure.

### Compute reconstruction caching

`createProductionRunner()` returns a runner with a per-source `Function` cache. At 60 Hz with stable compute, this turns up to 60 `new Function` invocations per second into 1 per unique source. Cache lives for the worker's lifetime; new workers start fresh.

### Subscriber-notification semantics

Strategies and `StrategyHandle` iterate a **snapshot** of the listener set (`for (const listener of [...this.listeners])`). Safe mid-notify behaviour:

- Listener unsubscribes itself: fires for this delivery; absent on next.
- Listener unsubscribes another: the other still fires for this delivery (was in snapshot); absent on next.
- Listener subscribes a new one: new listener does **not** fire on this delivery; starts on next.
- Listener triggers synchronous state change (e.g. `cancel()`): recursive notify iterates a fresh snapshot. Bounded by adopter's own re-entry guard.

Matches the React idiom of "subscribe on commit, observe on next change". Verified in `test/subscriber-race.test.ts`.

### React lifecycle specifics

- **Strict Mode double-mount**: each effect setup creates a fresh strategy + worker; cleanup destroys the previous. Verified by a Strict-Mode test asserting `terminateCalls.length === workerCount`.
- **SSR**: `useSyncExternalStore`'s `getServerSnapshot` returns initial state (`data: undefined`, `isComputing: false`, all snapshot ids `undefined`). No worker is created on the server.
- **Inputs identity**: hook tracks `options.streaming` and `options.intent` independently by reference. Raw-value path: adopters memoise object literals (or pass primitives). `Source<T>` path: identity is whatever the source's `getSnapshot()` returns; the substrate consumes via subscription rather than identity comparison. Compute closures are deduplicated by source string, so inline arrows are fine.

## Test layout convention

Tests live in `packages/coherent-derivation/test/` and `demo/test/`, **not** colocated with source. Reasons:

1. **Tarball cleanliness without build glue.** Library publishes `src/**/*.ts` to npm so adopter bundlers resolve sourcemaps to readable code. Colocated `*.test.ts` would either bloat the tarball or require explicit `!src/**/*.test.ts` negations.
2. **Source listing is library-only.** `ls src/` answers "what is this library", not "what does it test".
3. **Test utilities sit naturally in `test/utils/`.** `FakeWorker`, `asWorker`, `computeRequest` colocate with the tests they support.

## SVI fitter (Phase 2)

Demo-internal calibration engine in `demo/src/svi/`. Fitter is the demo's reference compute, not a library primitive — the demo's worker wires it as the substrate's compute via `workerFactory`. Includes `fitSviSliceWithCalendarFloor` (soft-penalty floor) and `repairCalendarArb` (iterative, dense floor) for production-realistic surface scaling.

**Parametric form (Gatheral & Jacquier 2014).** Per-slice raw-SVI: `w(k) = a + b·(ρ·(k − m) + √((k − m)² + σ²))` in log-moneyness `k = log(K/F)` with `w = IV² · T`. SSVI / SVI-JW / multi-slice joint calibration deferred to post-v1.

**Constraints.** `b ≥ 0`, `|ρ| ≤ 1`, `σ > 0`, level coupling `a + b·σ·√(1 − ρ²) ≥ 0`. Branded `SviParams` minted only by `validateParams`; level floor uses `(1 − ρ)·(1 + ρ)` to stay numerically stable as `|ρ| → 1`.

**Reparametrisation.** LM operates on unconstrained `u = (a, b̃, ρ̃, m, σ̃)` with `b = softplus(b̃)`, `ρ = tanh(ρ̃)`, `σ = softplus(σ̃)`. Level coupling enforced as a soft quadratic penalty appended to the residual vector. Chain-rule multipliers expressed in terms of the constrained parameter for numerical robustness at large `b̃` / `σ̃`.

**Generic Levenberg-Marquardt** (`lm-solver.ts`). SVI-free; takes `f(p)`, `J(p)` callbacks. Marquardt scale-invariant damping `(JᵀJ + λ·diag(JᵀJ)) δ = −Jᵀr` (λ·I form fails on multi-scale problems — NIST Misra1a `JᵀJ` diagonal spans ≈10¹¹). λ ← λ/2 on accept, λ ← λ × 10 on reject. Three convergence criteria: gradient `‖Jᵀr‖∞ < gradTol·(1 + ‖p‖)`, step `‖δ‖ < stepTol·(1 + ‖p‖)`, max 100 iterations. Cholesky linear solve with floored diagonal.

**Zeliade initial guess** (`initial-guess.ts`). Outer 2-D grid over `(m, σ)`; for fixed `(m, σ)` the SVI form is linear in `(α, β, γ) = (a, b·ρ, b)`, solved via 3×3 normal equations with ridge regularisation; cone projection enforces `γ ≥ 0`, `|β| ≤ γ`, level floor. Deterministic across runs.

**Failure-mode taxonomy** (discriminated-union `FitResult`): `invalid-input` / `underdetermined` (< 3 quotes) / `no-convergence` / `constraint-violation` / `numerical-failure`.

**Output-side no-arbitrage** (`no-arb.ts`). `butterflyCheck(params, kGrid)` evaluates Gatheral's `g(k)`. `calendarCheck(slices, kGrid)` verifies `w(k, T_{i+1}) ≥ w(k, T_i)` consecutively.

**Performance** (M-series Mac, `npm run bench`): 10-strike fit p99 ~0.23 ms; 50-strike ~0.44 ms; 200-strike ~1.5 ms; full surface (50 × 6) ~2.5 ms. CI gate (`demo/test/svi-perf.test.ts`) uses coarse budgets for CI variance; `demo/bench/svi.bench.ts` is the authoritative source.

**scipy cross-validation.** `demo/tools/generate-scipy-reference.py` (pinned `scipy==1.13.0`) regenerates `demo/test/fixtures/scipy-reference.json`. CI does not run Python; reviewers re-run locally.

## Demo

Demo lives under `demo/`. Vite + React 19 + Tailwind v4. Financial register: JetBrains Mono / Inter, slate / OKLCH palette, tabular-nums, dense layout.

### Worker integration via `workerFactory`

The library reconstructs `compute` via `new Function(source)`, which has no module resolution; the SVI fitter is too large to cross as a stringified closure. The demo bundles `demo/src/worker/svi-worker.ts` containing the fitter directly and passes a `workerFactory` to `useCoherentDerivation`:

- Listens for `WorkerInbound` (typed via `import type { WorkerInbound, WorkerOutbound } from "@oracaus/coherent-derivation"` — protocol is exported and semver-stable from v0.5.0).
- Ignores `inbound.source` and dispatches directly to `computeSurface` in `demo/src/worker/compute-surface.ts` — extracted so it's directly testable.
- Receives a full-surface `DemoSurfaceInput` (`slices`, `trueParamsPerSlice`, `tickIndex`); calls `fitSviSlice` per slice; runs `repairCalendarArb` over a 200-point k-grid; emits `DemoSurfaceOutput` (`perMaturity`, `surfaceArbStatus`, `sourceTickIndex`, `computeMs`).
- `surfaceArbStatus` is `arb-free` / `repair-applied` / `repair-failed` / `arb-violation` (last fires when `repairMode = "off"` — user-elected risk). Emit policy is unconditional; status is for instrumentation. The Panel's chip rail surfaces it.

Pattern documented in `demo/README.md` and the library's README.

### Two-panel demo architecture

Both panels run their own worker instance (each `useCoherentDerivation` mounts its own). The fits land independently. The difference is React-side:

- **NAIVE** (`useNaiveFit`): post-on-every-tick to its worker; returns `{ data, isComputing, pendingCount }`. The "latest input view" the panel displays is **not** held in `useNaiveFit` — it's sourced from `feed.tick` directly via `App.tsx`'s `naiveDisplayInputs` projection. Displayed `(dots, curve)` pair is `(feed.tick → projection, naive.data.fitResult)` — two independently-updating views; tearing visible when they disagree. `MAX_PENDING_QUEUE = 20` bounds the worker's inbound backlog (demo drops; production naive systems drop or block).
- **ORACAUS** (`useGatedFit` → `useCoherentDerivation`): library holds visible state during in-flight compute and commits `(input, output)` atomically. Dots come from `data.sourceSlice`; curve from `data.fitResult.params`; both coherent by construction. The streaming strategy conflates inputs internally — no queue growth.

Note: variable names, mode keys, hook names retain `gated*` — they describe the *mechanism* (gating compute behind composition coherence). User-visible labels say ORACAUS.

### Display state pipeline — single 5 Hz clock

Every consumer downstream of `App.tsx` reads state through a `useThrottled` boundary at `DISPLAY_REFRESH_INTERVAL_MS = 200` ms. Per-panel props are bundled into a composite via `useMemo` and throttled — chart, stats ribbon, status chips, and mismark metric all reflect the same instant. `currentTickIndex` is part of the composite so the lag metric and chart data flush together.

**Single source of truth for "current displayed tick"**: `feed.tick` (5 Hz throttled in `useFeed`). Both the lag chip's `currentTickIndex` prop AND the naive panel's "latest input view" derive from it. `useNaiveFit` does **not** maintain its own `latestInputs` slot.

Three rates:

- **Feed tick rate** (50–500 Hz, user-controllable): synthetic option-chain refit cadence.
- **Worker compute rate** (~17 Hz at default 50 × 200 / ~58 ms p99 warm on M-series Mac, measured via `npm run bench`).
- **Display refresh** (5 Hz): matches trading-desk display-throttle cadence.

`Panel`, `Smile`, `MismarkSparkline`, `OptionChainTable` are `React.memo`'d. SVG paths in `Smile` are `useMemo`'d on params+scales.

### Synthetic feed

`demo/src/feed.ts:SyntheticFeed`. Deterministic mulberry32 PRNG drives:

- GBM spot evolution (`r = 0.05`, `σ = 0.20`, `Δt = 1/(252·50)` years per tick)
- One **global** Ornstein-Uhlenbeck walk on `(a*, b*, ρ*, m*, σ*)` anchored on SPX-style values (`a* = 0.04`, `b* = 0.1`, `ρ* = -0.5`, `m* = 0`, `σ* = 0.2`).
- Per-slice params: `a_T = a* · T`; `b, ρ, m, σ` shared across maturities. T-scaling on `a` makes the TRUE underlying surface calendar-arb-free at every k.
- Per-(strike, maturity) observed IV: `√(w(k, params_T) / T) + Gaussian noise` (default `ivNoise = 0.001` ≈ 10 bps, SPX-ATM-realistic).

TRUE surface is arb-free by construction; per-(k, T) IV noise produces per-slice fits that occasionally violate the calendar bound — the noise regime `repairCalendarArb` targets.

Vol-shock multiplier amplifies σ_spot and OU diffusion × 5 for a 10-second burst. URL params: `?seed=<int>`, `?mode=recording`.

### Surface dimensions + control surface

Default: **50 expiries × 200 strikes per slice** — ~58 ms p99 warm on M-series Mac (measured via `npm run bench`), inside the [50, 150] ms Form 2 zone (at its lower edge) and matching SPX-style surfaces' typical 30–60 expiry count. Expiry count user-selectable from `{12, 30, 50, 70, 80}`; each step's tooltip shows the bench-derived p99 compute. (12 is the smallest count where all five display tenors land on distinct ladder entries.)

Display-maturity selector (`{1M, 3M, 6M, 1Y, 2Y}`) is a top-bar global control — comparison demands both panels on the same tenor. Displayed slice index derived via `findClosestMaturityIdx(buildExpiryLadder(nExpiriesFitted), displayMaturityYears)` so the selection survives expiry-count changes. The label set is exported as `DISPLAY_MATURITIES` from `Controls.tsx` for shared use (panel subtitle, etc.).

### Calendar-arb repair pipeline

`computeSurface` runs `fitSviSlice` per slice, then `repairCalendarArb(slices, fitResults, kGrid)`:

1. Detect via `calendarCheck` on a 200-point k-grid.
2. Iterate up to `MAX_REPAIR_ITERATIONS = 8` rounds; re-fit violating slices with `fitSviSliceWithCalendarFloor` using a dense floor on the full k-grid.
3. Cap cumulative re-fits at `maxRepairsPerPass(nSlices) = min(30, max(10, ceil(nSlices × 0.3)))` (21 for the 70-slice default).
4. Soft-penalty calibration: floor weight `1000`, over-floor margin `1 × 10⁻⁷`, LM `maxIterations: 200` for floor-constrained fits.
5. Failure modes on `RepairResult.failureReason`: `pre-existing-fit-failure` / `too-many-violations` / `refit-failure` / `residual-violations`.

Empirical calendar-arb distribution at σ_iv = 0.001 (SPX-ATM-realistic) — measured at the prior 70 × 200 default (5 seeds × 30 ticks), not re-measured at the current 50 × 200: **~69 % arb-free, ~27 % repair-applied, ~4.7 % repair-failed**.

### Two-metric verification UI per panel

- **In-panel coherence error**: `Σ_i |w_fit(k_i, params) − w_obs_i| / N`. What the library fixes. NAIVE under shock: large. ORACAUS: LM-residual scale.
- **Ground-truth tracking error**: `||fitted_params − source_true_params||` normalised. What neither library can prevent (lag is intrinsic). Both panels: similar magnitude.

Showing both makes the demo's correctness claim falsifiable on screen.

**Per-mode lag formula** (`demo/src/metrics.ts:computeSnapshotLag`):

- **NAIVE: `abs(latestInputs.tickIndex − data.sourceTickIndex)`.** Displayed `(dots, curve)` pair lives in independent state slots; chip reports absolute structural gap. Both directions matter — heavy load: queue saturates, `data` lags; light load: eager `setData` runs ahead of throttled input view.
- **ORACAUS: `max(0, currentTickIndex − data.sourceTickIndex)`.** Substrate's atomic commit makes `(latestInputs.tickIndex === data.sourceTickIndex)` identically; meaningful lag is staleness of the coherent snapshot vs feed's latest tick.

`switch` + `assertNever(mode)` in a single helper so a future third mode would type-error.

**Chip semantics — mismark-driven for both modes**. The `COHERENT`/`STALE` header chip is computed from `stickyCoherent` (mismark-with-hysteresis) only. It annotates the *visible* tear directly. The lag metric number has its own red/green tone via `stickyLagStale` (`LAG_STALE_ENTER_TICKS = 10`, `LAG_OK_RETURN_TICKS = 3`). Decoupling chip (visible tear) from lag (structural number) keeps each signal honest.

Regression tests in `demo/test/metric-coherence.test.ts` lock in both formulas and the source-identity invariant.

### Cross-view hover overlay

Hover any smile or chain row — a synchronised diagnostic overlay lights up across all three views. Demonstrates "keep downstream stages synchronous": the substrate's atomic emit is the alignment point; the per-point overlay is a render-body `useMemo` against it.

State: single `hoveredK: number | null` in `App.tsx`, owned outside the 5 Hz boundary so hover feels immediate. Threaded to both `Panel`s and `OptionChainTable`. Persisted across `displayMaturityYears` changes.

Cursor stroke colour matches panel identity (`CURSOR_STROKE_STALE` / `CURSOR_STROKE_OK` inlined in `Smile.tsx`).

Tooltip is HTML + backdrop-blur, not SVG (`backdrop-filter` doesn't apply to SVG). Absolutely-positioned HTML `<div>` sibling of the SVG inside a `position: relative` wrapper. Overlay uses `pointer-events: none`; pointer handlers on the wrapper drive the x → k inversion.

Overlay content (five lines): `k` (hovered log-moneyness), `IV fit`, `IV obs` (nearest quote within ±0.02 in k), `miss = IV fit − IV obs`, `g(k)` (Gatheral butterfly indicator from `demo/src/svi/diagnostics.ts`).

Tolerance: ±0.02 in k for both nearest-quote lookup (`Smile.tsx`) and chain-row highlight (`OptionChainTable.tsx`). At 200 strikes over [−1, 1] inter-strike step ≈ 0.01 in k.

`demo/src/svi/diagnostics.ts` exposes `kDerivatives(k, params)` (analytical first/second derivatives in k, validated by central-difference tests) and re-exports `gatheralG`.

### Viewport-too-small notice

Below `1280 × 700`, `<ViewportNotice />` renders as a fixed backdrop-blur overlay on top of the (clipped) running demo. Compositor-only: alpha composition + `backdrop-filter: blur(...)`.

### Plotting

Hand-rolled SVG (`demo/src/components/Smile.tsx`). `d3-scale` (~5 KB gz) for tick math + linear scales. No charting library; rationale in `Smile.tsx`'s module header. Memoised at export.

**Adaptive y-axis per maturity, with hysteresis + compositor-only transitions**:

1. **Anchor baseline** (`App.tsx:computeSmileYRange(T, xRange)`). Derives IV range from feed's anchor parameters at the displayed maturity. Recomputed only on `displayMaturityT` change. Anchor params mirrored from `feed.ts` rather than imported.
2. **Sticky range with expand-only hysteresis** (`App.tsx:stickyYRange`). Expands outward when observed IV envelope overflows; never shrinks within a maturity selection. Reset to anchor on maturity change.
3. **Compositor-only y-axis transition via Web Animations API** (`Smile.tsx` `useLayoutEffect` on yRange change). Re-renders content at the NEW range immediately, then runs WAAPI animation on the inner chart group via `element.animate(...)`. Interpolation runs on the GPU compositor — zero React re-renders, zero main-thread style/layout/paint per frame, no forced reflow. `transform-origin: 0 0` with `transform-box: view-box` (load-bearing for steady-state perf — `fill-box` would recompute bounding box on every content change, triggering document-wide reflows). Animation handle stored in ref so a new yRange change can cancel an in-flight one. Respects `prefers-reduced-motion: reduce` via `duration: 0`.
4. **ClipPath on the chart interior** (`Smile.tsx:clipId`) confines dots, curve, and hover cursor to the inner chart rect. Unique per-instance id via `useId()`.

### Deployment

`.github/workflows/deploy-demo.yml`. Path-filtered to `demo/**` + `packages/coherent-derivation/**`. Builds library + typechecks + builds demo via Vite + uploads via `actions/upload-pages-artifact` + deploys via `actions/deploy-pages`. Pages source: GitHub Actions (no `gh-pages` branch). Custom domain `demo.oracaus.dev` held by `demo/public/CNAME`. Vite `base: "/"` for both build and dev. No `.nojekyll` needed.

### Browser support

Module workers (`{ type: "module" }`) required. Chrome 80+, Firefox 114+, Safari 15+. Older browsers see a graceful notice.

### Bundle

App index 288 KB / 92 KB gz; SVI worker 15 KB / ~5 KB gz; CSS 24 KB / ~5 KB gz. Total demo ~102 KB gz against a <250 KB gz budget.

### Deferred: transferable worker protocol

Current build ships structured-clone postMessage at ~250 KB per surface message. `MAX_PENDING_QUEUE = 20` in `useNaiveFit` bounds the OOM risk inherent to NAIVE's post-on-every-tick. The production follow-up is a **transferable `ArrayBuffer` worker protocol** — pack the surface into one Float64Array and `postMessage(buffer, [buffer])` for zero-copy transfer. Removes per-send clone cost but doesn't remove the need for the cap. Deferred for scope.

## Test suite

569 tests pass across the library and the demo (2 self-skipped gated on `--expose-gc`; run via `npm run test:memory`).

**Library tests** (`packages/coherent-derivation/test/`): `worker-loop`, `worker-bridge`, `worker-error`, `production-runner`, `snapshot-id`, `derivation-strategy-streaming`, `derivation-strategy-intent`, `api-surface.test-d`, `strategy-race`, `use-coherent-derivation`, `ssr`, `strategy-properties` (`fast-check` invariants × randomised scenarios — monotonic ids, atomic commits, streaming-absorb, intent-cancel-restart, post-destroy silence), `memory-baseline` (10k mount/destroy + 10k setInputs/cancel; `--expose-gc`), `bundle-size` (worker <3 KiB gz, main <8 KiB gz), `real-worker-integration` (end-to-end via `node:worker_threads`), `compute-edge-cases`, `subscriber-race`, `hook-edge-cases`.

**Demo surface tests** (`demo/test/`): `svi-calendar-repair` (4), `feed-surface` (8), `worker-integration` (6), `svi-calendar-repair-properties` (2 — 200 randomised violation patterns), `svi-diagnostics` (7 — central-difference validation of `kDerivatives`), `metric-coherence` (10 — per-mode lag formula + source-identity locks), `projection-staleness` (9 — `expectedSurfaceSize` guard).

**Phase 2 SVI tests** (`demo/test/`): `svi-form`, `svi-jacobian` (1 000 random samples vs central differences), `lm-solver` (Rosenbrock, NIST Misra1a, Lanczos1-style), `svi-initial-guess` (Zeliade SPX recovery), `svi-fitter` (round-trip recovery + invalid-input taxonomy), `svi-no-arb`, `svi-calendar`, `svi-edge-cases`, `svi-cross-validation` (scipy reference), `svi-perf` (p99 + max latency gates), `svi-properties` (determinism + scale-invariance sweep).

**Commentary subsystem tests** (`demo/test/commentary/` — 11 files): `phase-reducer`, `scenarios`, `events`, `scheduler`, `phrase-sequencer`, `region`, `should-enqueue-insight`, `use-commentary`, `toolbar-commentary-toggle`, `CommentaryToast`, `CommentaryToastStack`. Each targets one subsystem of the live-narration engine.

`vitest.config.ts` has a leftover `passWithNoTests: true` that can be removed on the next cleanup pass.

## Code conventions

- TypeScript strict; `noUncheckedIndexedAccess: true`; `exactOptionalPropertyTypes: true` per package
- Branded primitives for opaque values (Price, Quantity, Delta, etc. — see `packages/connection-layer/src/types.ts`)
- Discriminated unions with `assertNever` in default arms for exhaustiveness
- ESM only (`"type": "module"`)
- Imports include `.js` extensions in source for ESM correctness

## Voice and conventions

When generating prose for this codebase (CHANGELOG, READMEs, articles):

- Peer-to-peer; senior engineers as the assumed reader
- Specific named scenarios with values, not abstract placeholders
- No marketing register ("exciting", "powerful", "unlock", "leverage", "supercharge")
- British English (organisation, optimised, behaviour, favour, centre)
- Honest about uncertainty and scope
- Don't tell readers what to think
- AP-style possessives: "Oracaus's" (not "Oracaus'")
- User-visible labels: "ORACAUS" for the panel that uses the library; "NAIVE" for the comparison panel. Variable/mode/file names retain `gated*` (they name the mechanism).
