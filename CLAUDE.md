# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                # run all tests (vitest run)
npm run bench           # run benchmarks
npm run bench:memory    # benchmarks with GC exposure for heap measurements
npm run typecheck       # tsc --noEmit
npm run build           # tsc (outputs to dist/)
npm run build:watch     # incremental build
npm run lint            # biome lint
npm run format          # biome format --write
npm run check           # biome check (lint + format)
```

To run a single test file: `npx vitest run src/render-gate.test.ts`

The pre-commit hook runs `biome check --staged`. Do not bypass it.

## Architecture

This is a TypeScript library (ESM, Node ≥18) that implements a causally-consistent client-side pipeline for real-time trading UIs. Three pipeline stages compose in sequence:

```
WebSocket → SharedWorker/BroadcastChannel → BackpressureValve → RenderGate → UI
```

**SharedWorker** (`src/orchestrator.worker.ts`) — holds a single WebSocket per browser session, shared across all tabs via `BroadcastChannel`. Eliminates per-tab connection multiplication and cross-tab state divergence.

**BackpressureValve** (`src/backpressure-valve.ts`) — viewport-aware conflation. Throttles 2,000 ticks/sec to 60fps for visible instruments; drops off-screen instruments entirely.

**RenderGate** (`src/render-gate.ts`) — the core primitive. Enforces per-instrument causal coherence: holds render until every required stream for a given instrument carries the same causal key. Emits `CoherentSnapshot` with a `coherentInstruments: ReadonlySet<InstrumentId>` that identifies exactly which instruments are safe to display or trade against.

**Tab-side interface**: `src/client-bridge.ts` (main export at `.`).  
**React hook**: `src/react/use-trading-stream.ts` (export at `./react`).

## Key type concepts

All domain numerics are **branded primitives** (`Price`, `Quantity`, `Delta`, etc.) — cast once at ingestion boundaries with `value as Price`, never inside the gate. This prevents silent structural aliasing between e.g. `delta` and `bid`.

`CausalMetadata` carries one of three optional fields: `correlationId`, `eventTimestamp`, or `globalSequence`. Which field is populated determines which coherence extractor to use (`byCorrelationId`, `byEventTimestamp`, `byGlobalSequence`). When all are absent, the gate falls back to v0.1.0 wall-clock semantics.

**Stream freshness contract** — two classes:

- `passThrough: true` (prices) — valid-until-superseded; last known value accepted without a matching causal key.
- `passThrough: false` (positions, greeks) — invalid-if-stale; gate holds until the stream delivers a message with the current causal key.

`byGlobalSequence` requires `gapStrategy` on every stream (`'wait'`, `'snapshot-fetch'`, or `'partial'`). The TypeScript type system enforces this at the call site via `SequencedCoherenceKeyExtractor` narrowing `RenderGateConfig` to `SequencedRenderGateConfig`.

## Test suite

36 tests in `src/render-gate.test.ts`, grouped D1–D16. Each suite targets a specific failure mode or invariant (false coherence, false incoherence, supersession, gap detection, etc.). When adding tests, follow the existing suite naming and grouping.

Benchmarks live in `bench/` (not under `src/`) and are excluded from the test run.
