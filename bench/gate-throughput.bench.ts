/**
 * Gate Throughput Benchmarks
 *
 * Measures operations per second (hz) for the RenderGate under various load
 * scenarios. Each bench() call is one "operation" — a complete fill cycle
 * (position + greeks update → coherent emit) on N instruments.
 *
 * Results are presented side-by-side (v0.1.0 vs v0.3.0) within each describe
 * block. The hz delta shows the overhead of per-instrument causal tracking
 * relative to the stream-level v0.1.0 wall-clock gate.
 *
 * Memory: run with `pnpm bench:memory` (--expose-gc) to get heap deltas
 * alongside the hz numbers. The afterAll blocks log rough heap estimates.
 */

import { afterAll, bench, describe } from "vitest";
import { RenderGate, type RenderGateConfig } from "../src/render-gate";
import type {
  CausalMetadata,
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

// All streams passThrough — every update triggers an immediate emit with zero
// coherence logic. Measures the irreducible framework cost: state writes,
// snapshot construction, and shallow copies. The floor below v0.1.0.
const PASSTHROUGH_CONFIG: RenderGateConfig = {
  streams: {
    prices: { passThrough: true },
    positions: { passThrough: true },
    greeks: { passThrough: true },
  },
  holdTimeout: 200,
  wallClockWindow: 50,
};

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

// ─── Single-instrument throughput ─────────────────────────────────────────────
// Baseline: 1 instrument, 1 fill per bench iteration. Measures the marginal
// cost of per-instrument causal tracking vs stream-level wall-clock.

describe("Single-instrument throughput — 1 fill per iteration", () => {
  afterAll(() => {
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
      const heap = process.memoryUsage().heapUsed;
      console.log(
        `\n  Heap after single-instrument suite: ${(heap / 1024 / 1024).toFixed(1)} MB`,
      );
    }
  });

  bench("passthrough (identity — zero coherence overhead)", () => {
    const gate = new RenderGate(() => {}, PASSTHROUGH_CONFIG);
    gate.updatePrices(new Map([["AAPL", tick("AAPL", 150)]]));
    gate.updatePositions(position("AAPL", 100));
    gate.updateGreeks(greeks("AAPL"));
    gate.destroy();
  });

  bench("v0.1.0 wall-clock baseline (no causal tracking)", () => {
    const gate = new RenderGate(() => {}, V1_CONFIG);
    gate.updatePrices(new Map([["AAPL", tick("AAPL", 150)]]));
    gate.updatePositions(position("AAPL", 100));
    gate.updateGreeks(greeks("AAPL"));
    gate.destroy();
  });

  bench(
    "v0.3.0 causal: 1 instrument — overhead of per-instrument tracking",
    () => {
      const gate = new RenderGate(() => {}, V3_CONFIG);
      gate.updatePrices(new Map([["AAPL", tick("AAPL", 150)]]));
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-1" }));
      gate.destroy();
    },
  );
});

// ─── Multi-instrument scaling ─────────────────────────────────────────────────
// One rebalance event: N instruments, all sharing the same correlationId.
// Measures how gate throughput scales with blotter size.

describe("Multi-instrument scaling — rebalance", () => {
  afterAll(() => {
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
      const heap = process.memoryUsage().heapUsed;
      console.log(
        `\n  Heap after multi-instrument suite: ${(heap / 1024 / 1024).toFixed(1)} MB`,
      );
    }
  });

  for (const N of [10, 50, 100, 500]) {
    const IDS = Array.from({ length: N }, (_, i) => `INST-${i}`);
    const PRICE_MAP = new Map(IDS.map((id) => [id, tick(id, 100)]));

    bench(`passthrough: ${N} instruments (identity baseline)`, () => {
      const gate = new RenderGate(() => {}, PASSTHROUGH_CONFIG);
      gate.updatePrices(PRICE_MAP);
      for (const id of IDS) gate.updatePositions(position(id, 100));
      for (const id of IDS) gate.updateGreeks(greeks(id));
      gate.destroy();
    });

    bench(`v0.3.0: ${N} instruments, single rebalance fill`, () => {
      const gate = new RenderGate(() => {}, V3_CONFIG);
      gate.updatePrices(PRICE_MAP);
      for (const id of IDS) {
        gate.updatePositions(position(id, 100, { correlationId: "REBAL-1" }));
      }
      for (const id of IDS) {
        gate.updateGreeks(greeks(id, { correlationId: "REBAL-1" }));
      }
      gate.destroy();
    });
  }
});

// ─── Independent fills at scale ───────────────────────────────────────────────
// N instruments each with their own fill (different correlationIds). This is
// the worst case for v0.2.0 (mutual supersession), the key scenario v0.3.0
// solves. Every instrument should resolve independently.

describe("Independent fills at scale — the v0.3.0 correctness scenario", () => {
  // Accumulated partial counts across all iterations per N. Expect 0 for all N.
  // A non-zero value here means a hold timer fired — a correctness regression.
  const partialsByN = new Map<number, number>();

  afterAll(() => {
    if (partialsByN.size > 0) {
      console.log(
        "\n── Independent fills: partial count per N (expect 0) ────",
      );
      for (const [n, count] of partialsByN) {
        const flag = count > 0 ? " ← REGRESSION" : "";
        console.log(
          `  ${String(n).padStart(3)} instruments: ${count} partials${flag}`,
        );
      }
      console.log("─────────────────────────────────────────────────────\n");
    }
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
      const heap = process.memoryUsage().heapUsed;
      console.log(
        `\n  Heap after independent-fills suite: ${(heap / 1024 / 1024).toFixed(1)} MB`,
      );
    }
  });

  for (const N of [10, 100, 500]) {
    const IDS = Array.from({ length: N }, (_, i) => `INST-${i}`);
    const PRICE_MAP = new Map(IDS.map((id) => [id, tick(id, 100)]));

    bench(
      `v0.3.0: ${N} instruments, independent fills (all resolve, 0 partials)`,
      () => {
        let partialCount = 0;
        const gate = new RenderGate((s) => {
          if (s.isPartial) partialCount++;
        }, V3_CONFIG);
        gate.updatePrices(PRICE_MAP);
        for (const id of IDS) {
          gate.updatePositions(
            position(id, 100, { correlationId: `FILL-${id}` }),
          );
        }
        for (const id of IDS) {
          gate.updateGreeks(greeks(id, { correlationId: `FILL-${id}` }));
        }
        partialsByN.set(N, (partialsByN.get(N) ?? 0) + partialCount);
        gate.destroy();
      },
    );
  }
});

// ─── Mixed causal fraction ────────────────────────────────────────────────────
// Simulates a partial backend rollout where some fills carry correlationId
// and others don't. Tests gate behaviour during incremental instrumentation.

describe("Mixed causal metadata fraction — 100 instruments", () => {
  const N = 100;
  const IDS = Array.from({ length: N }, (_, i) => `INST-${i}`);
  const PRICE_MAP = new Map(IDS.map((id) => [id, tick(id, 100)]));

  bench("100% causal: all fills instrumented", () => {
    const gate = new RenderGate(() => {}, V3_CONFIG);
    gate.updatePrices(PRICE_MAP);
    for (const id of IDS) {
      gate.updatePositions(position(id, 100, { correlationId: `FILL-${id}` }));
      gate.updateGreeks(greeks(id, { correlationId: `FILL-${id}` }));
    }
    gate.destroy();
  });

  bench("50% causal: half instrumented, half fall back to wall-clock", () => {
    const gate = new RenderGate(() => {}, V3_CONFIG);
    gate.updatePrices(PRICE_MAP);
    for (let i = 0; i < IDS.length; i++) {
      const id = IDS[i];
      const causal = i % 2 === 0 ? { correlationId: `FILL-${id}` } : {};
      gate.updatePositions(position(id, 100, causal));
      gate.updateGreeks(greeks(id, causal));
    }
    gate.destroy();
  });

  bench(
    "0% causal: no instrumentation (pure wall-clock, v0.1.0 semantics)",
    () => {
      const gate = new RenderGate(() => {}, V1_CONFIG);
      gate.updatePrices(PRICE_MAP);
      for (const id of IDS) {
        gate.updatePositions(position(id, 100));
        gate.updateGreeks(greeks(id));
      }
      gate.destroy();
    },
  );
});

// ─── Memory scaling ───────────────────────────────────────────────────────────
// Measures heap growth per instrument at steady state. Run with --expose-gc
// to get reliable baseline measurements.

describe("Memory: per-instrument heap cost at steady state", () => {
  bench("heap cost: 1000 instruments seeded in gate", () => {
    const N = 1000;
    const IDS = Array.from({ length: N }, (_, i) => `INST-${i}`);
    const gate = new RenderGate(() => {}, V3_CONFIG);

    gate.updatePrices(new Map(IDS.map((id) => [id, tick(id, 100)])));
    for (const id of IDS) {
      gate.updatePositions(position(id, 100, { correlationId: `FILL-${id}` }));
      gate.updateGreeks(greeks(id, { correlationId: `FILL-${id}` }));
    }

    gate.destroy();
  });
});
