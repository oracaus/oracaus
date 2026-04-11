# Changelog

## v0.5.0 (Planned) — Synthetic Feed Generator + Interactive Demo

Builds on v0.4.0's batched emit. Both features below assume the gate emits once per synchronous burst — the demo's visual comparison and the synthetic feed's `step(n)` mode only make sense against that cadence.

### New: Synthetic feed generator (`src/synthetic/`)

Self-contained `FeedSimulator` with no runtime dependencies: GBM spot prices (Euler-Maruyama), Black-Scholes Greeks (Abramowitz & Stegun normCdf), Poisson fill arrivals (exponential inter-arrivals), and log-normal latency parameterised by (p50, p99). `synchronous: true` + `step(n)` mode for deterministic bench load generation. In `step(n)` mode the generator drives the gate through its batched emit path, exercising the same code consumers will hit in production.

### New: Interactive demo (`demo/`)

Vite + React blotter. Two gates run simultaneously on the same synthetic feed: wall-clock (v0.1.0) and causal (v0.3.0+). Per-row coherence indicators, rolling partial rate comparison, and a Volatility Shock button that spikes λ×5 and σ×3 to stress the gate. With batched emit in place, each gate emits once per conceptual event, so wall-clock's degradation shows up as visibly wrong rows (mixed causality flagged as coherent), not as visually faster updates — the demo's job is to make this failure mode legible.

---

## v0.4.0 (Planned) — Batched Emit

A single-purpose breaking release that changes `RenderGate`'s emit cadence from synchronous-per-update to microtask-batched. Carved out of the original v0.4.0 scope because it's the one API change planned for the near term and deserves a version of its own — v0.5.0's synthetic feed and demo assume it as the baseline.

### Motivation

In v0.3.0 the gate emits synchronously on every resolved update. Under a synchronous burst of N updates (the canonical case: a 500-instrument rebalance where all positions and all greeks arrive in the same tick), this fires N emits × O(N) snapshot construction = **O(N²) per burst**. More importantly, it emits N intermediate snapshots that consumers should never see as distinct frames — a rebalance is one conceptual event, not N.

v0.4.0 collapses all emits that resolve within the same synchronous burst into a single emit, scheduled via `queueMicrotask`. The gate becomes microtask-debounced: every state write (`updatePrices`, `updatePositions`, `updateGreeks`) schedules a flush if one isn't already pending, and the flush runs at the end of the current tick. This is semantically correct for a render gate — renders are frame-scoped — and aligns the gate's emit cadence with the BackpressureValve upstream.

### What this fixes

- **O(N²) → O(N) per burst.** A 500-instrument rebalance does one snapshot construction, not 500. The v0.3.0 bench's 500-instrument cliff (16.4 ops/sec for v0.3.0, 19.6 for passthrough) should flatten entirely — both variants converge on the single-flush cost and the 1.2x gap collapses.
- **Wall-clock over-emission asymmetry eliminated.** In v0.3.0, once the wall-clock gate becomes coherent, every subsequent `updatePositions`/`updateGreeks` call re-emits a full snapshot (~2N−1 emits per iteration for N instruments). The causal path only emits once per causal-key resolution (~N emits). This produced the counterintuitive 1.95x speedup of 100% causal over 0% wall-clock in the mixed causal fraction bench — not because causal is cheaper per emit, but because wall-clock over-emits. v0.4.0 collapses both paths to exactly one emit per burst; the asymmetry disappears. Throughput differences between the two gates then reflect coherence-logic cost only, which is where it belongs.
- **Paves the way for v0.5.0's demo.** The side-by-side wall-clock vs causal comparison is only honest if each gate emits once per conceptual event. Without batching, wall-clock would appear to update "faster" purely due to over-emission, obscuring the failure mode the demo is meant to highlight.

### Implementation notes for the rewrite

1. **`queueMicrotask`, not `requestAnimationFrame`.** rAF isn't available in SharedWorker context. Microtask flushes at the end of the current synchronous burst, which naturally groups a single WebSocket message handler's updates into one emit and collapses synchronous bench loops into one frame. Consumers wanting additional rAF-level batching should layer it at the React boundary, not inside the gate.

2. **`flushPending` boolean guards the schedule.** First write in a tick schedules via `queueMicrotask`; subsequent writes in the same tick check the flag and skip scheduling (they still mutate state normally). On flush, clear the flag, then run the existing `emit()` logic exactly once over the accumulated state.

3. **Hold timers continue to fire on wall-clock time.** Hold timers use real `setTimeout` and are unchanged. A hold-timer expiry routes through the same `scheduleFlush` path — so if a hold timer fires during a pending synchronous burst, it does not produce an extra emit, it ensures the pending burst is flushed with `isPartial: true` for the expired instrument.

4. **`isPartial` and gap-flag aggregation across the burst.** When multiple instruments resolve in the same microtask and one of them has an unresolved gap, the batched snapshot's `isPartial` must be `true`. v0.3.0's "consumed on first coherent delivery" semantics still hold — the gap is acknowledged exactly once, just now on a potentially-batched emit. Aggregation rule: `isPartial = OR across all instruments touched this flush`.

5. **`sequenceId` semantics tighten.** One `sequenceId` increment per flush, not per internal resolution. This is strictly cleaner than v0.3.0 where a 500-instrument rebalance burns 500 sequence IDs — the number now corresponds to conceptual frames, not write events. Unit test **D9** (sequenceId monotonicity) stays valid; test **D15** (500-instrument independent fills) will need the expected emit count updated from 500 to 1.

6. **`destroy()` must cancel the pending flush.** Set a `destroyed` boolean; guard the top of the queued `emit()` callback on it. Unit test **D14** ("no emit after destroy") will catch a regression.

7. **Test migration (~36 tests).** Tests that assert on `snapshots` immediately after an update call must insert `await flushMicrotasks()` (helper: `() => new Promise(r => queueMicrotask(r))`) before the assertion. Add the helper to the test harness once; wire it into each assertion site. Mechanical — no logic changes.

8. **`client-bridge` and `use-trading-stream` forward the batched cadence naturally.** Both consume `(snapshot) => ...` callbacks and neither assumes synchronous emit. No changes expected in the tab-side or React-hook layers.

9. **Benchmark updates.** `gate-throughput.bench.ts`'s 500-instrument case will need its expected-performance commentary updated; the "mixed causal fraction" suite will need its narrative rewritten since the 1.95x ratio is the bug being fixed, not the feature being measured. Consider adding a new bench that measures coherence-logic cost in isolation (post-batching) to replace what the mixed-fraction suite currently implies.

### Breaking changes

| Symbol                        | Change                                                                      |
| ----------------------------- | --------------------------------------------------------------------------- |
| `RenderGate` emit semantics   | Synchronous per-update → microtask-batched (one emit per synchronous burst) |
| `CoherentSnapshot.sequenceId` | Incremented once per flush, not once per internal resolution                |
| Test-side assertions          | Must `await flushMicrotasks()` between state writes and snapshot assertions |

---

## v0.3.0 — Per-Instrument Causal Coherence

### The v0.2.0 Gap

v0.2.0 enforced causal coherence at the **stream level**: one `pendingCausalKey` globally, one `lastCausalId` per stream. Any two instruments filling concurrently broke this.

When AAPL received a position update tagged `"FILL-456"` and GOOG simultaneously received `"FILL-789"`, each instrument's position superseded the other's pending key. AAPL's Greeks arrived with `"FILL-456"` — which no longer matched the gate's pending key of `"FILL-789"`. The gate ping-ponged between the two instruments' causal keys indefinitely. Neither instrument ever reached coherence.

The consequence was not wrong P&L arithmetic — `(price.mid - position.avgCost) * position.quantity` is correct per instrument regardless. The consequence was operational paralysis: the gate emitted a continuous stream of partials, execution was permanently suppressed, and `isPartial` — designed as a brief safety valve during fills — became the default state on any book with more than one instrument trading actively. The gate had degraded from "coherent snapshots with occasional partials during fills" to "permanent partials." `coherentInstruments` did not exist yet, so there was no per-instrument signal to indicate which instruments were actually safe to act on.

### What Changed

**Per-instrument causal tracking.** `lastCausalId`, `lastSequence`, `pendingCausalKeys`, `holdTimers`, and `hasUnresolvedGaps` all become per-instrument Maps. AAPL on `"FILL-456"` and GOOG on `"FILL-789"` resolve independently. One instrument's supersession does not affect any other.

**`CoherentSnapshot.coherentInstruments`.** A `ReadonlySet<InstrumentId>` added to every snapshot. An instrument is in the set when all its required streams carry the same causal key. Consumers can guard P&L aggregation with `coherentInstruments.has(id)` without consulting `isPartial`.

**`isPartial` redefined.** Was: "the gate timed out or was superseded before all streams resolved" (stream-level). Now: true when either a hold timer fired for ≥1 instrument this cycle (gate gave up waiting), or a coherent delivery arrived for an instrument with an unresolved sequence gap (gap consumed; the snapshot is the first clean one after a data hole). Both cases signal that consumers should treat the snapshot with caution. Distinct from startup incompleteness — `isPartial` never fires on initial load.

**`GapEvent.instrumentId` added.** Gap detection was already per-stream; it is now per-instrument-per-stream. The `onGap` callback receives the exact instrument that experienced the sequence gap.

**Supersession is silent.** In v0.2.0, a supersession immediately emitted a partial snapshot. In v0.3.0, per-instrument supersession replaces the pending key and re-arms the hold timer without emitting. The next coherent emit naturally excludes the superseded instrument from `coherentInstruments`, which is the signal consumers need.

**Wall-clock path unchanged.** The wall-clock fallback (for uninstrumented feeds) remains stream-level. This is documented as a known limitation — per-instrument wall-clock tracking is a future concern.

### Gap Flag Semantics Change

In v0.2.0, `hasUnresolvedGap` persisted across emits until cleared by a coherent delivery. In v0.3.0, the flag is per-instrument and is consumed on the first coherent delivery after the gap — that delivery is marked `isPartial: true`, and subsequent deliveries for the same instrument are clean. This is more precise: the gap is acknowledged exactly once at the moment coherence is first re-established.

### New: Benchmarks (`bench/`)

Three Vitest bench files measuring correctness-under-load, throughput, and valve conflation.

**`gate-latency.bench.ts`** measures false coherence rate and time-to-coherence overhead. Each bench accumulates boolean outcomes across iterations; `afterAll` logs the derived rates alongside the Vitest hz table. The Time-to-Coherence suite accumulates per-iteration μs overhead for the 1-instrument case and reports p50/p99 in `afterAll`.

The file contains a "False Incoherence Rate" suite but it only benchmarks v0.3.0 — there is no v0.1.0 bench inside it. The reason: measuring v0.1.0 false incoherence requires a real >50ms gap between position and greeks arrival. In a synchronous bench both updates arrive at 0ms spread, so the wall-clock gate always emits coherently — a v0.1.0 bench here would show 0% suppressed regardless of the gate's actual behaviour under load, making it meaningless. The definitive v0.1.0 vs v0.3.0 comparison for this scenario uses `vi.useFakeTimers()` in unit test **D2**.

**`gate-throughput.bench.ts`** measures ops/sec across single-instrument, multi-instrument scaling (10/50/100/500 instruments), independent-fill scenarios, and mixed causal metadata fractions. A zero-coherence passthrough baseline (all streams `passThrough: true`), v0.1.0, and v0.3.0 are presented side-by-side within each `describe` block. The independent-fills suite accumulates partial counts across all iterations and flags any non-zero result as a correctness regression.

**`valve-throughput.bench.ts`** measures BackpressureValve ingest throughput and conflation ratio at burst multiples of 10×, 50×, and 100×.

Benchmark results (Apple M5, Node 22):

| Scenario                                      | hz (v0.3.0) | hz (passthrough) |
| --------------------------------------------- | ----------- | ---------------- |
| Single-instrument                             | ~1,169k/s   | ~1,186k/s        |
| 10-instrument rebalance                       | ~88.5k/s    | ~91.2k/s         |
| 50-instrument rebalance                       | ~3.2k/s     | ~3.1k/s          |
| 100-instrument rebalance                      | ~574/s      | ~574/s           |
| 500-instrument rebalance                      | ~16.4/s     | ~19.6/s          |
| 500-instrument independent fills (0 partials) | ~16.4/s     | —                |

The passthrough column is a zero-coherence identity baseline (all streams `passThrough: true`). At 1–100 instruments, v0.3.0 causal tracking adds no measurable overhead — it is within noise of the framework floor.

At 500 instruments the passthrough baseline itself reaches only ~19.6 ops/sec — well below 60Hz — confirming the bottleneck is not causal tracking. The v0.3.0 overhead here is ~1.2x (16.4 vs 19.6 ops/sec). There are two compounding costs, with different fix stories:

**Cost 1: N emits per rebalance (fixable — microtask batching).** In the bench, all 500 greeks arrive synchronously, so `tryEmitCausal` fires 500 times → `emit()` called 500 times. Each call copies all N state keys, giving O(N²) total. Deferring with `queueMicrotask` would collapse all synchronous resolutions into one emit: O(N²) → O(N). The trade-off is that emit becomes asynchronous — all 36 tests that check `snapshots` immediately after calling `updateGreeks()` would need an `await Promise.resolve()` inserted, and consumers relying on synchronous emit would need updating. Deferred emit is semantically correct for a render gate (renders already schedule via RAF), but it is a breaking change.

**Cost 2: O(N) object spread on every emit (not fixable without API change).** `emit()` constructs the snapshot with `{ ...state.positions }`, `{ ...state.greeks }`, `{ ...state.prices }`. Even with batching to one emit, this is O(N) per emit — the per-rebalance cost becomes O(N), not O(1). Removing the copy requires either: handing out live state references (breaks snapshot immutability — consumers would see future mutations through a held snapshot), or a persistent data structure (HAMT-style structural sharing, not in the JS stdlib). Neither is straightforward.

**Why the bench result does not reflect production.** Fills arrive via WebSocket — each message is its own event loop turn. At 500 instruments in a real rebalance, the 500 `emit()` calls are spread across real time (tens to hundreds of milliseconds). Each individual emit copies N-key objects once: O(N), but sequentially over real time, not piled into a single synchronous tick. The 60Hz budget of ~16ms applies per frame, not per emit. The gate's BackpressureValve conflates incoming ticks to frame rate before they reach the render layer. The bench result is a valid measure of gate throughput under artificial synchronous load, but it does not represent whether a 500-instrument blotter is usable in production — it is.

### Breaking Changes

| Symbol                       | Change                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `StreamState.lastCausalId`   | `Record<StreamId, string \| null>` → `Record<StreamId, Record<InstrumentId, string>>`    |
| `StreamState.lastSequence`   | `Record<StreamId, number>` → `Record<StreamId, Record<InstrumentId, number>>`            |
| `CoherentSnapshot`           | adds `coherentInstruments: ReadonlySet<InstrumentId>`                                    |
| `CoherentSnapshot.isPartial` | redefined: "hold timer fired for ≥1 instrument" (was: stream-level supersession/timeout) |
| `GapEvent`                   | adds `instrumentId: InstrumentId`                                                        |

---

## v0.2.0 — Causal Identity Coherence

v0.1.0 approximated coherence by checking whether messages arrived within a 50ms wall-clock window. This broke in both directions:

- **False coherence**: Two independent market events land within 50ms — the gate treats them as related, mixing unrelated positions and Greeks into a single snapshot.
- **False incoherence**: A single fill event fans out across services with variable latency. The Greeks engine takes 60ms. The gate times out at 50ms and suppresses execution unnecessarily.

v0.2.0 replaced the time-based proxy with **causal identity**. Messages carry metadata (`correlationId`, `eventTimestamp`, or `globalSequence`) identifying which market event produced them. The gate waits for all required streams to report the same causal key before emitting.

**Wall-clock fallback**: when messages lack causal metadata, the extractor returns `null` and the gate automatically falls back to v0.1.0 wall-clock behaviour (50ms window). This makes v0.2.0 backwards-compatible with uninstrumented feeds.

**Gap detection**: `byGlobalSequence` feeds support per-stream gap detection with three strategies — `wait`, `snapshot-fetch`, and `partial` — each reflecting the different semantics of a missing sequence on positions vs. Greeks vs. prices.
