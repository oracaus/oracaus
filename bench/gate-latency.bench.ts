/**
 * Gate Latency Benchmarks
 *
 * Measures correctness-under-load: the rate at which each gate version makes
 * correct coherence decisions. Throughput (hz) is secondary — the key metrics
 * are false coherence rate and false incoherence rate.
 *
 * False coherence: gate emits a "coherent" snapshot that mixes data from
 *   causally unrelated events. Dangerous for tradeable actions.
 *
 * False incoherence: gate suppresses a genuinely coherent snapshot because
 *   causally related data arrived outside the timing window. Degrades UX.
 *
 * The benchmarks run each scenario N times and accumulate outcome counts.
 * afterAll logs the derived rates so they appear alongside the hz numbers.
 *
 * Timing: performance.now() provides ~1μs resolution in Node 18+. Each bench
 * iteration creates and destroys a fresh gate to avoid state accumulation.
 */

import { afterAll, bench, describe } from "vitest";
import { RenderGate, type RenderGateConfig } from "../src/render-gate";
import type {
  CausalMetadata,
  CoherentSnapshot,
  CurrencyCode,
  Delta,
  Gamma,
  GreeksUpdate,
  InstrumentId,
  PositionUpdate,
  Price,
  PriceTick,
  Quantity,
  Theta,
  Timestamp,
  Vega,
} from "../src/types";
import { byCorrelationId } from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tick(
  id: InstrumentId,
  mid: number,
  causal: CausalMetadata = {},
): PriceTick {
  return {
    instrumentId: id,
    bid: (mid - 0.5) as Price,
    ask: (mid + 0.5) as Price,
    mid: mid as Price,
    timestamp: Date.now() as Timestamp,
    ...causal,
  };
}

function position(
  id: InstrumentId,
  qty: number,
  causal: CausalMetadata = {},
): PositionUpdate {
  return {
    instrumentId: id,
    quantity: qty as Quantity,
    avgCost: 100 as Price,
    currency: "USD" as CurrencyCode,
    timestamp: Date.now() as Timestamp,
    ...causal,
  };
}

function greeks(id: InstrumentId, causal: CausalMetadata = {}): GreeksUpdate {
  return {
    instrumentId: id,
    delta: 0.5 as Delta,
    gamma: 0.02 as Gamma,
    vega: 0.15 as Vega,
    theta: -0.01 as Theta,
    timestamp: Date.now() as Timestamp,
    ...causal,
  };
}

function priceMap(id: InstrumentId, mid: number): Map<InstrumentId, PriceTick> {
  return new Map([[id, tick(id, mid)]]);
}

const V1_CONFIG: RenderGateConfig = { wallClockWindow: 50, holdTimeout: 200 };

const V3_CONFIG: RenderGateConfig = {
  coherenceKey: byCorrelationId,
  streams: {
    prices: { passThrough: true },
    positions: { passThrough: false },
    greeks: { passThrough: false },
  },
  holdTimeout: 200,
  wallClockWindow: 50,
};

// ─── D: False Coherence Rate ──────────────────────────────────────────────────
// Scenario: two unrelated fills arrive within 50ms. v0.1.0 treats them as
// coherent (wall-clock window satisfied). v0.3.0 detects the key mismatch
// and correctly withholds a coherent snapshot.
//
// Definition:
//   falseCoherenceRate = emits where isPartial=false AND data is causally mixed
//                        / total runs

describe("False Coherence Rate — independent fills within 50ms window", () => {
  let v1Total = 0,
    v1FalseCoherent = 0;
  let v3Total = 0,
    v3FalseCoherent = 0;

  afterAll(() => {
    const v1Rate =
      v1Total > 0 ? ((v1FalseCoherent / v1Total) * 100).toFixed(1) : "N/A";
    const v3Rate =
      v3Total > 0 ? ((v3FalseCoherent / v3Total) * 100).toFixed(1) : "N/A";
    console.log("\n── False Coherence Rate ─────────────────────────────");
    console.log(
      `  v0.1.0 wall-clock : ${v1Rate}% (${v1FalseCoherent}/${v1Total})`,
    );
    console.log(
      `  v0.3.0 causal     : ${v3Rate}% (${v3FalseCoherent}/${v3Total})`,
    );
    console.log("─────────────────────────────────────────────────────\n");

    // Regression guards: wall-clock should always be fooled by independent
    // fills within the same synchronous tick; causal should never be.
    if (v1Total > 0 && v1FalseCoherent / v1Total < 0.95) {
      throw new Error(
        `v0.1.0 false coherence rate regressed: ${v1Rate}% (expected ≥95%)`,
      );
    }
    if (v3FalseCoherent > 0) {
      throw new Error(
        `v0.3.0 false coherence rate regressed: ${v3FalseCoherent} mixed emits (expected 0)`,
      );
    }
  });

  bench(
    "v0.1.0 wall-clock: independent fills [EXPECT ~100% false coherence]",
    () => {
      v1Total++;
      const snapshots: CoherentSnapshot[] = [];
      const gate = new RenderGate((s) => snapshots.push(s), V1_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));
      // Two independent fills — both within 50ms (same synchronous tick)
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-A" }));
      gate.updatePositions(position("AAPL", 50, { correlationId: "FILL-B" }));
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-A" }));

      // v0.1.0: all within same ms → wall-clock coherent → mixed causality emitted
      if (snapshots.some((s) => !s.isPartial)) v1FalseCoherent++;

      gate.destroy();
    },
  );

  bench("v0.3.0 causal: independent fills [EXPECT 0% false coherence]", () => {
    v3Total++;
    const snapshots: CoherentSnapshot[] = [];
    const gate = new RenderGate((s) => snapshots.push(s), V3_CONFIG);

    gate.updatePrices(priceMap("AAPL", 150));
    gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-A" }));
    gate.updatePositions(position("AAPL", 50, { correlationId: "FILL-B" }));
    gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-A" }));

    // v0.3.0: FILL-A greeks arrive but pending key is FILL-B → withheld
    if (snapshots.some((s) => !s.isPartial)) v3FalseCoherent++;

    gate.destroy();
  });
});

// ─── False Incoherence Rate ───────────────────────────────────────────────────
// Scenario: one fill fans out; Greeks engine is slow (T+60ms, > 50ms window).
// v0.1.0 suppresses the coherent snapshot. v0.3.0 emits it regardless of timing.
//
// NOTE: v0.1.0's false incoherence requires real timer advancement (>50ms gap
// between position and greeks arrival). Synchronous bench cannot reproduce it —
// both updates arrive at 0ms spread so the wall-clock gate emits either way.
// See unit test D2 for the definitive comparison using vi.useFakeTimers().
// This suite measures v0.3.0's emission rate (expect 100% coherent, 0% suppressed).

describe("False Incoherence Rate — correlated fill, Greeks delayed 60ms", () => {
  let v3Total = 0,
    v3Emitted = 0;

  afterAll(() => {
    const v3BlockRate =
      v3Total > 0
        ? (((v3Total - v3Emitted) / v3Total) * 100).toFixed(1)
        : "N/A";
    console.log(
      "\n── False Incoherence Rate (coherent snapshots suppressed) ──",
    );
    console.log(
      `  v0.3.0 causal     : ${v3BlockRate}% suppressed (${v3Total - v3Emitted}/${v3Total}) [expect 0%]`,
    );
    console.log(
      "─────────────────────────────────────────────────────────────\n",
    );

    // Regression guard: causal path must emit every correlated fill.
    if (v3Total > 0 && v3Emitted < v3Total) {
      throw new Error(
        `v0.3.0 false incoherence rate regressed: ${v3Total - v3Emitted}/${v3Total} suppressed (expected 0)`,
      );
    }
  });

  bench(
    "v0.3.0 causal: correlated fill, same correlationId [EXPECT coherent]",
    () => {
      v3Total++;
      const snapshots: CoherentSnapshot[] = [];
      const gate = new RenderGate((s) => snapshots.push(s), V3_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
      // Greeks arrive "late" — same correlationId, causal gate doesn't care about timing
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-1" }));

      if (snapshots.some((s) => !s.isPartial)) v3Emitted++;

      gate.destroy();
    },
  );
});

// ─── Time-to-Coherence ────────────────────────────────────────────────────────
// Measures the latency from the triggering position update to the coherent emit,
// across different numbers of concurrent instruments.
//
// In synchronous benchmarks, "latency" is purely computational (no real time
// passes). The measurement captures gate processing overhead per instrument.
// The 1-instrument case is the cleanest signal: position → greeks → emit overhead.

describe("Time-to-Coherence — causal path (synchronous measurement)", () => {
  // Accumulates per-iteration overhead for the 1-instrument case.
  // Multi-instrument benches emit N times per iteration (one per instrument resolving),
  // so their per-emit overhead is reported via hz only.
  const latenciesUs: number[] = [];

  afterAll(() => {
    if (latenciesUs.length > 0) {
      const sum = latenciesUs.reduce((a, b) => a + b, 0);
      const avg = sum / latenciesUs.length;
      const sorted = [...latenciesUs].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];
      console.log("\n── Time-to-Coherence (1 instrument, μs) ─────────────");
      console.log(`  samples : ${latenciesUs.length}`);
      console.log(`  avg     : ${avg.toFixed(2)}μs`);
      console.log(`  p50     : ${p50.toFixed(2)}μs`);
      console.log(`  p99     : ${p99.toFixed(2)}μs`);
      console.log("─────────────────────────────────────────────────────\n");
    }
  });

  bench("1 instrument: position → coherent emit (gate overhead)", () => {
    let emitTime = 0;
    const gate = new RenderGate(() => {
      emitTime = performance.now();
    }, V3_CONFIG);

    gate.updatePrices(priceMap("AAPL", 150));
    const t0 = performance.now();
    gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
    gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-1" }));
    latenciesUs.push((emitTime - t0) * 1000); // ms → μs

    gate.destroy();
  });

  bench("10 instruments: all positions + all greeks → all coherent", () => {
    const IDS = Array.from({ length: 10 }, (_, i) => `INST-${i}`);
    const gate = new RenderGate(() => {}, V3_CONFIG);

    gate.updatePrices(new Map(IDS.map((id) => [id, tick(id, 100)])));

    for (const id of IDS) {
      gate.updatePositions(position(id, 100, { correlationId: `FILL-${id}` }));
    }
    for (const id of IDS) {
      gate.updateGreeks(greeks(id, { correlationId: `FILL-${id}` }));
    }

    gate.destroy();
  });

  bench("100 instruments: all positions + all greeks → all coherent", () => {
    const IDS = Array.from({ length: 100 }, (_, i) => `INST-${i}`);
    const gate = new RenderGate(() => {}, V3_CONFIG);

    gate.updatePrices(new Map(IDS.map((id) => [id, tick(id, 100)])));

    for (const id of IDS) {
      gate.updatePositions(position(id, 100, { correlationId: `FILL-${id}` }));
    }
    for (const id of IDS) {
      gate.updateGreeks(greeks(id, { correlationId: `FILL-${id}` }));
    }

    gate.destroy();
  });

  bench("500 instruments: all positions + all greeks → all coherent", () => {
    const IDS = Array.from({ length: 500 }, (_, i) => `INST-${i}`);
    const gate = new RenderGate(() => {}, V3_CONFIG);

    gate.updatePrices(new Map(IDS.map((id) => [id, tick(id, 100)])));

    for (const id of IDS) {
      gate.updatePositions(position(id, 100, { correlationId: `FILL-${id}` }));
    }
    for (const id of IDS) {
      gate.updateGreeks(greeks(id, { correlationId: `FILL-${id}` }));
    }

    gate.destroy();
  });
});
