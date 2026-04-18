# Trading UI Pipeline

A high-performance client-side architecture for real-time trading interfaces. A shared-worker orchestrator offloads the main thread, a backpressure valve conflates high-frequency ticks to display frame rate, and a render gate enforces **per-instrument causal coherence** before every snapshot reaches the UI.

## Motivation

This solves the most difficult [frontend architecture problems nobody solves before production](https://www.linkedin.com/pulse/six-frontend-architecture-problems-nobody-solves-before-ka%C5%82ka-fdo2e/) in real-time trading UIs:

- **Main-thread congestion (v0.1.0)**: A 2,000 tick/sec WebSocket feed processes messages on the main thread, competing with rendering. v0.1.0 moved message processing into a SharedWorker, keeping the main thread free for layout and paint.
- **Per-tab connection multiplication (v0.1.0)**: Each browser tab opens its own WebSocket, multiplying backend bandwidth and causing cross-tab state divergence. The SharedWorker holds a single connection and broadcasts coherent snapshots to all tabs via BroadcastChannel.
- **Tick rate exceeds display rate (v0.1.0)**: At 2,000 ticks/sec, scheduling a re-render per tick wastes CPU on frames the display will never show. The BackpressureValve conflates incoming ticks to 60fps for visible instruments and drops off-screen instruments entirely.
- **False coherence (v0.2.0)**: A price tick from one fill and a Greeks update from a different fill arrive within the same 50ms wall-clock window and are presented as a coherent snapshot. A tradeable quote is computed against the wrong hedge ratios.
- **False incoherence (v0.2.0)**: A legitimate fill fans out slowly — the Greeks engine takes 60ms, beyond the 50ms wall-clock window. The gate withholds execution. The trader sees a stale blotter.
- **Operational paralysis under concurrent fills (v0.3.0)**: When AAPL's fill (`"FILL-456"`) and GOOG's fill (`"FILL-789"`) overlap in time, they mutually supersede each other's pending causal key at the stream level. The gate ping-pongs between keys indefinitely — neither instrument ever reaches coherence, and the gate emits a continuous stream of partials. `isPartial`, designed as a brief safety valve during fills, becomes the permanent default state. The collision probability grows with blotter size and fill rate, but two concurrently active instruments are enough to trigger it.
- **False incoherence under fast reprice (v0.4.0)**: With a sequenced feed, Greeks run on a faster reprice loop than fills. A fill from 10s ago paired with a Greeks snapshot from 2s ago is arithmetically valid (per-unit sensitivities × current quantity), but v0.3.0's equality rule across causal keys withholds it. Instruments bounce out of `coherentInstruments` on every reprice; portfolio aggregates go `null` under healthy idle state. v0.4.0's `freshness: "monotonic"` relaxes the rule to `dependent.key ≥ anchor.key` on orderable extractors (`byEventTimestamp`, `byGlobalSequence`).

## Architecture

![Architecture diagram](./assets/architecture-blueprint.png)

### Pipeline stages

#### SharedWorker & BroadcastChannel

Single WebSocket connection shared across all tabs. Distributes coherent snapshots to every open tab simultaneously. Eliminates per-tab bandwidth multiplication and cross-tab state divergence.

![SharedWorker multi-tab topology](./assets/shared-worker.png)

#### BackpressureValve

Viewport-aware conflation. Throttles 2,000 ticks/sec to 60fps for visible instruments. Instruments off-screen are dropped entirely.

![BackpressureValve diagram](./assets/backpressure-valve.png)

#### RenderGate

Per-instrument causal coherence enforcement. Holds render until every required stream carries the same causal key for the same instrument. The `CoherentSnapshot` emitted carries a `coherentInstruments` set identifying exactly which instruments are safe to use.

![RenderGate diagram](./assets/render-gate.png)

### Stream freshness semantics

| Stream    | passThrough | Meaning                                                               |
| --------- | ----------- | --------------------------------------------------------------------- |
| prices    | `true`      | Valid-until-superseded. Last known price is correct until next tick.  |
| positions | `false`     | Invalid-if-stale. Must carry the triggering causal key (latest fill). |
| greeks    | `false`     | Invalid-if-stale. Must reflect the latest reprice.                    |

## Configuration

```typescript
import { RenderGate } from "./src/render-gate";
import { byCorrelationId } from "./src/types";

const gate = new RenderGate(
  (snapshot) => {
    // snapshot.coherentInstruments: Set of instruments safe to display
    // snapshot.isPartial: true if any instrument timed out this cycle
  },
  {
    coherenceKey: byCorrelationId, // or byEventTimestamp, byGlobalSequence

    // The non-passThrough stream whose key is the reference for all others.
    // Required in v0.4.0. Must be a declared non-passThrough stream.
    anchorStream: "positions",

    streams: {
      prices: { passThrough: true },
      // Anchor matches itself — "match" is the only valid freshness here.
      positions: { passThrough: false, freshness: "match" },
      // Monotonic: greeks.key ≥ positions.key is sufficient. Requires an
      // orderable extractor (byEventTimestamp or byGlobalSequence). Under
      // byCorrelationId, only "match" is valid at runtime.
      greeks: { passThrough: false, freshness: "match" },
      // gapStrategy applies to byGlobalSequence feeds only — see coherence strategies table
    },

    holdTimeout: 200, // p99 tail latency of your slowest downstream service
    wallClockWindow: 50, // fallback window for uninstrumented feeds
  },
);
```

### Freshness: `"match"` vs `"monotonic"` (v0.4.0)

Per-stream. Governs how a non-passThrough stream's causal key is compared against the anchor's:

| Freshness     | Rule                            | Valid extractors                                  | Use when                                                                                                       |
| ------------- | ------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `"match"`     | `stream.key === anchor.key`     | all                                               | Default. Dependent stream is produced whole with the anchor (fan-out fills). `byCorrelationId` supports only this. |
| `"monotonic"` | `compare(stream.key, anchor.key) ≥ 0` | `byEventTimestamp`, `byGlobalSequence`          | Dependent stream is a pure function of market state and may run ahead of the anchor (Greeks on a fast reprice loop vs. slower fill cadence). |

The anchor itself is always `"match"` (it is its own reference). Attempting `"monotonic"` with `byCorrelationId` throws at construction — correlation IDs are opaque strings, not orderable.

### Coherence strategies

| Strategy           | Use when                                             | Properties                                                              |
| ------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `byCorrelationId`  | Backend stamps all fan-out messages with a shared ID | Cleanest. No time arithmetic. Requires backend instrumentation.         |
| `byEventTimestamp` | Feed provides exchange-originating timestamps        | Works without backend modification. Collision risk at HFT event rates.  |
| `byGlobalSequence` | Sequenced feeds (Solace, AMPS)                       | Most general. Enables gap detection. Requires per-stream `gapStrategy`. |

### Wall-clock fallback

When messages lack causal metadata the extractor returns `null` and the gate falls back to v0.1.0 wall-clock behaviour (50ms window). This makes v0.3.0 compatible with feeds that do not emit causal metadata, whether permanently or during incremental instrumentation rollout.

## The `coherentInstruments` Set

Every `CoherentSnapshot` carries a `ReadonlySet<InstrumentId>`:

```typescript
export interface CoherentSnapshot {
  prices: Record<InstrumentId, PriceTick>;
  positions: Record<InstrumentId, PositionUpdate>;
  greeks: Record<InstrumentId, GreeksUpdate>;
  sequenceId: number;
  renderedAt: number;

  /**
   * Instruments for which all required streams carried the same causal key
   * this cycle. An instrument is absent when it is:
   *   - Still loading (no data on all required streams yet).
   *   - Pending causal resolution (non-passThrough stream hasn't matched the key).
   *   - In a hold-timer expiry or active gap — coherence was abandoned or is unresolved.
   */
  coherentInstruments: ReadonlySet<InstrumentId>;

  /**
   * True when either:
   *   - A hold timer fired for ≥1 instrument this cycle (gate gave up waiting), OR
   *   - A coherent delivery resolved after a sequence gap (gap consumed; data hole exists).
   * Distinct from "startup incompleteness" — isPartial never fires on initial load.
   */
  isPartial: boolean;
}
```

### Per-row staleness indicator

```tsx
function BlotterRow({ id }: { id: string }) {
  const { snapshot } = useTradingStream({ instrumentIds: [id] });
  if (!snapshot) return <Skeleton />;

  const coherent = snapshot.coherentInstruments.has(id);
  const price = snapshot.prices[id];
  const position = snapshot.positions[id];

  return (
    <tr style={{ opacity: coherent ? 1 : 0.5 }}>
      <td>
        {coherent ? "●" : "○"} {id}
      </td>
      <td>{price?.mid.toFixed(2) ?? "—"}</td>
      <td>{position?.quantity ?? "—"}</td>
    </tr>
  );
}
```

### Portfolio delta exposure

```typescript
function portfolioDeltaExposure(snapshot: CoherentSnapshot): number | null {
  if (snapshot.isPartial) return null;

  let exposure = 0;
  for (const [id, pos] of Object.entries(snapshot.positions)) {
    if (!snapshot.coherentInstruments.has(id)) continue;
    const g = snapshot.greeks[id];
    if (!g) continue;
    exposure += pos.quantity * g.delta;
  }
  return exposure;
}
```

This is where causal coherence earns its keep. `pos.quantity * g.delta` combines two `passThrough: false` streams — a position from one fill and Greeks computed for the _same_ fill. If AAPL's position reflects `"FILL-789"` but the Greeks engine is still returning values computed against `"FILL-456"`, the delta is wrong for this position, and the exposure contribution is wrong. `coherentInstruments.has(id)` is the per-instrument guard that prevents this: AAPL only appears in the set once position and Greeks both carry the matching causal key.

Note the contrast with a price-only P&L calculation like `(price.mid - pos.avgCost) * pos.quantity`: prices are `passThrough: true`, the position's `avgCost` is a field on the position record itself, and both are correct in isolation regardless of Greeks state. That calculation does not need a coherence guard — which is exactly why the interesting example to show is this one.

`isPartial` guards _portfolio completeness_, not per-instrument correctness. When an instrument times out, it drops out of `coherentInstruments` and the loop skips it — but for a portfolio-aggregated risk number like delta exposure, a silently dropped leg understates the true exposure (the missing instrument may carry the largest delta). Returning `null` signals "the aggregate is not trustworthy right now" rather than showing a number that looks complete but isn't. Per-row consumers (the blotter row above) don't need this guard because they scope to a single instrument; portfolio-level risk aggregates do.

## React Usage

```tsx
import { useTradingStream } from "./src/react/use-trading-stream";

const { snapshot } = useTradingStream({
  instrumentIds: ["AAPL", "GOOG"],
  viewportIds: visibleIds,
});

if (!snapshot) return <Skeleton />;

// Only AAPL is in scope — check per-instrument coherence
const coherent = snapshot.coherentInstruments.has("AAPL");
const price = snapshot.prices["AAPL"];
const position = snapshot.positions["AAPL"];

const pnl =
  coherent && price && position
    ? (price.mid - position.avgCost) * position.quantity
    : null;
```

## Backend Requirements

The gate requires the backend to stamp messages with causal metadata:

```json
{
  "stream": "positions",
  "payload": {
    "instrumentId": "AAPL",
    "quantity": 100,
    "avgCost": 150.25,
    "currency": "USD",
    "timestamp": 1700000000000,
    "correlationId": "FILL-456"
  }
}
```

All messages produced by the same market event must share the same `correlationId`. The positions and Greeks updates triggered by a single fill must carry the same value. The gate uses this identity to match streams per instrument.

If your feed does not yet emit causal metadata, the wall-clock path buys time while instrumentation is rolled out.

## Running Tests

```bash
npm test
```

46 tests across 23 suites:

| Suite | What it proves                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| D1    | False coherence under v0.1.0, correct rejection under v0.3.0                                                                   |
| D2    | False incoherence under v0.1.0, no suppression under v0.3.0                                                                    |
| D3    | Supersession: silent key replacement in v0.3.0, resolves on winning key                                                        |
| D4    | Wall-clock fallback compatibility (zero-config = v0.1.0)                                                                       |
| D5    | Hold timeout: partial on expiry, timer cancel on coherent arrival                                                              |
| D6    | passThrough semantics (valid-until-superseded vs invalid-if-stale)                                                             |
| D7    | Gap detection: snapshot-fetch, wait, partial strategies; recovery path (first coherent after gap is partial, subsequent clean) |
| D8    | Alternative coherence extractors (byEventTimestamp, byGlobalSequence)                                                          |
| D9    | Snapshot correctness: sequenceId monotonicity, record-copy safety, shallow-reference contract, coherentInstruments type        |
| D10   | Per-instrument coherence: AAPL resolves before GOOG, each emit accurate                                                        |
| D11   | Mixed-mode feeds: wall-clock clears pendingCausalKeys, no double-emit                                                          |
| D12   | Gap flag: consumed on first coherent delivery, subsequent emits clean                                                          |
| D13   | byGlobalSequence backend contract (shared ID = coherent, per-message counter = timeout)                                        |
| D14   | Destroy: all per-instrument timers cleared, no emit after destroy                                                              |
| D15   | Cross-instrument independence: 500 instruments with independent fills, all resolve, 0 partials                                 |
| D16   | Mixed-latency blotter: fast instruments coherent before slow, timeouts isolated                                                |
| D17   | Monotonic freshness under `byEventTimestamp`: Greeks newer than position → coherent (v0.3.0 would withhold)                    |
| D18   | Monotonic freshness under `byGlobalSequence`: Greeks sequence > position sequence → coherent                                   |
| D19   | Monotonic — negative case: Greeks older than position still withheld (proves we haven't relaxed too far)                       |
| D20   | Monotonic — Greeks-before-position arrival order: resolves when position catches up with key ≤ buffered Greeks                 |
| D21   | Monotonic — hold timer cancels when dependent catches up to anchor                                                             |
| D22   | Validation: `freshness: "monotonic"` throws at construction under `byCorrelationId` or on a `passThrough` stream, and when `anchorStream` is omitted |
| D23   | Validation: `anchorStream` must name a declared non-passThrough stream                                                         |

## Running Benchmarks

```bash
npm run bench
```

Key outputs (Apple M5, Node 22):

```
Gate Latency — False Coherence Rate
  v0.1.0 wall-clock : ~100% (wall-clock window satisfied by independent fills)
  v0.3.0 causal     :    0% (key mismatch detected, correctly withheld)

Gate Throughput — Single-instrument
  passthrough (identity)  : ~1,209k ops/sec
  v0.1.0 wall-clock       : ~1,171k ops/sec
  v0.3.0 causal           : ~1,268k ops/sec

Gate Throughput — Multi-instrument scaling (v0.3.0 vs passthrough identity)
  10 instruments    : ~86.8k / ~90.3k ops/sec  (v0.3.0 / passthrough)
  50 instruments    :  ~3.2k /  ~3.1k ops/sec
  100 instruments   :   ~576 /   ~573 ops/sec
  500 instruments   :  ~15.9 /  ~19.6 ops/sec

Gate Throughput — Mixed causal fraction (100 instruments)
  100% instrumented : ~1,139 ops/sec
   50% instrumented :   ~792 ops/sec
    0% instrumented :   ~595 ops/sec
```

At 1–100 instruments, v0.3.0 causal tracking adds no measurable overhead over the passthrough baseline — single-instrument variance sits within JIT/GC noise (the ordering between the three variants flips between runs; in this run v0.3.0 causal is nominally _faster_ than passthrough by ~5%). At 500 instruments the overhead is ~1.23x (15.9 vs 19.6 ops/sec), explained by the bench's synchronous delivery pattern: `emit()` fires once per instrument with an O(N) object spread each time, O(N²) total in snapshot construction. The 500-instrument causal run also shows higher variance (rme ±7.3% vs ±0.1–0.6% at smaller scales) — another symptom of the O(N²) regime where a handful of GC pauses dominate the ten samples. In production this does not occur — fills arrive over real time as WebSocket messages, emits are spread across hundreds of milliseconds, and the BackpressureValve conflates ticks before the render layer. **v0.5.0's batched emit collapses this from O(N²) to O(N) even under the bench's synchronous load** (see "Coming in v0.5.0" below).

The mixed causal fraction numbers deserve a note: 100% instrumented is ~1.91x faster than 0% (pure wall-clock), which looks counterintuitive until you count emits. Once the wall-clock gate becomes coherent, every subsequent `updatePositions` / `updateGreeks` call re-emits a full snapshot — so 100 instruments produce ~2N−1 emits per iteration. The causal path only emits when a causal key resolves (~N emits per iteration). The observed 1.91x speedup matches the predicted 199:100 emit ratio (1.99x) within noise. Causal tracking wins here by _suppressing_ spurious re-emits, not by being cheaper per emit. **v0.5.0's batched emit erases this asymmetry entirely — both paths will emit exactly once per synchronous burst.**

A note on tail latencies: `min`/`max`/`p999` from individual bench samples can swing 10–20x versus `mean` at sub-microsecond scales — those are single outliers (scheduler hiccups, GC pauses) rather than representative behaviour. Compare `mean` and `p99` for stable signal. See CHANGELOG for a full analysis of the trade-offs.

For heap measurements:

```bash
npm run bench:memory
```

## File Structure

```
src/
  types.ts                    — Domain types, CausalMetadata, coherence extractors
  render-gate.ts              — Per-instrument causal gate
  render-gate.test.ts         — 46 tests (D1–D23)
  backpressure-valve.ts       — Viewport-aware tick conflation
  orchestrator.worker.ts      — SharedWorker: single WS, pipeline wiring
  client-bridge.ts            — Tab-side interface to the SharedWorker
  react/
    use-trading-stream.ts     — React hook for coherent snapshot consumption

bench/
  gate-latency.bench.ts       — False coherence rate, false incoherence (match vs monotonic), time-to-coherence p50/p99
  gate-throughput.bench.ts    — Multi-instrument scaling, causal fraction, freshness overhead (match vs monotonic)
  valve-throughput.bench.ts   — BackpressureValve conflation ratio
```

## Coming in v0.5.0 — Batched Emit

A single-purpose breaking release. The gate becomes microtask-debounced: all state writes that resolve within the same synchronous burst collapse into a single `CoherentSnapshot`, scheduled via `queueMicrotask`. A 500-instrument rebalance will emit once, not 500 times — collapsing snapshot construction from O(N²) to O(N) under the bench's synchronous load. This also erases the wall-clock over-emission asymmetry (~2N−1 emits vs ~N) that inflates v0.1.0's apparent throughput in the mixed causal fraction bench, and aligns the gate's emit cadence with the BackpressureValve upstream. `emit` becomes asynchronous; consumers that assert on snapshots immediately after a write must `await` a microtask flush. Sequenced after the freshness fix — batching incorrect-by-construction emits would only obscure the underlying semantic gap. See CHANGELOG for implementation notes.

## Coming in v0.6.0 — Synthetic Feed Generator + Interactive Demo

Builds on v0.5.0's batched emit cadence and v0.4.0's freshness floor.

- **Synthetic feed generator** (`src/synthetic/`): self-contained `FeedSimulator` with GBM spot prices, Black-Scholes Greeks, Poisson fill arrivals, and log-normal latency — no runtime dependencies. Synchronous bench mode for deterministic load generation; exercises the same batched emit path the demo consumes.
- **Interactive demo** (`demo/`): Vite + React blotter with per-row coherence indicators and a live side-by-side comparison of the wall-clock gate (v0.1.0) vs the causal gate (v0.3.0+) under a configurable volatility shock. Batched emit makes the visual comparison honest — each gate emits once per conceptual event, so wall-clock's degradation shows as _wrong_ data, not _more frequent_ data.

## Author

- [Przemyslaw Kalka](https://www.linkedin.com/in/przemyslawkalka/?locale=en_US)
