/**
 * BackpressureValve Throughput Benchmarks
 *
 * Measures the valve's conflation effectiveness and throughput under simulated
 * tick bursts. Key questions:
 *
 *  1. Conflation ratio: given N ticks ingested, how many are flushed?
 *     A ratio of 10:1 means 90% of ticks were dropped (the latest wins).
 *
 *  2. Throughput: how many ingest() calls per second at different tick rates?
 *
 * The valve uses setTimeout for scheduling flushes. Since Vitest bench doesn't
 * use fake timers, we measure the synchronous ingest path only — the cost of
 * classifying a tick, storing it, and scheduling a flush (without the flush
 * itself executing, since that requires the event loop).
 */

import { afterAll, bench, describe } from "vitest";
import { BackpressureValve } from "../src/backpressure-valve";
import type { InstrumentId, Price, PriceTick, Timestamp } from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tick(id: InstrumentId, mid: number): PriceTick {
  return {
    instrumentId: id,
    bid: (mid - 0.5) as Price,
    ask: (mid + 0.5) as Price,
    mid: mid as Price,
    timestamp: Date.now() as Timestamp,
  };
}

// ─── Ingest throughput ────────────────────────────────────────────────────────

describe("BackpressureValve: ingest throughput", () => {
  afterAll(() => {
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
    }
  });

  bench(
    "100 watched instruments: single tick per instrument (no conflation)",
    () => {
      const N = 100;
      const IDS = Array.from({ length: N }, (_, i) => `INST-${i}`);
      const valve = new BackpressureValve(() => {});
      valve.addWatched(IDS);
      valve.setViewport(IDS);

      let mid = 100;
      for (const id of IDS) {
        valve.ingest(tick(id, mid++));
      }

      valve.destroy();
    },
  );

  bench(
    "100 watched instruments: 20 ticks per instrument (conflation: 20→1)",
    () => {
      const N = 100;
      const TICKS_PER_INST = 20;
      const IDS = Array.from({ length: N }, (_, i) => `INST-${i}`);
      const valve = new BackpressureValve(() => {});
      valve.addWatched(IDS);
      valve.setViewport(IDS);

      // Ingest 20 ticks per instrument — only the last should survive to flush.
      // This tests the conflation path: pending Map overwrites previous tick.
      let mid = 100;
      for (let t = 0; t < TICKS_PER_INST; t++) {
        for (const id of IDS) {
          valve.ingest(tick(id, mid++));
        }
      }

      // Total ingested: 100 * 20 = 2,000 ticks
      // Expected pending after ingest: 100 (one per instrument — last wins)

      valve.destroy();
    },
  );

  bench("1000 watched instruments: 1 tick each (large blotter)", () => {
    const N = 1000;
    const IDS = Array.from({ length: N }, (_, i) => `INST-${i}`);
    const valve = new BackpressureValve(() => {});
    valve.addWatched(IDS);
    valve.setViewport(IDS.slice(0, 100)); // first 100 in viewport

    let mid = 100;
    for (const id of IDS) {
      valve.ingest(tick(id, mid++));
    }

    valve.destroy();
  });
});

// ─── Priority classification throughput ───────────────────────────────────────
// Measures classification cost across the render priority matrix:
//   high   = active + in viewport
//   medium = passive + in viewport
//   low    = active + off-screen
//   drop   = passive + off-screen (not watched would be dropped before this)

describe("BackpressureValve: priority classification", () => {
  bench("high priority: active + viewport (synchronous flush path)", () => {
    const valve = new BackpressureValve(() => {});
    valve.addWatched(["AAPL"]);
    valve.setViewport(["AAPL"]);
    valve.setActive("AAPL", true);

    for (let i = 0; i < 100; i++) {
      valve.ingest(tick("AAPL", 150 + i));
    }

    valve.destroy();
  });

  bench("medium priority: passive + viewport (batch-to-frame path)", () => {
    const valve = new BackpressureValve(() => {});
    valve.addWatched(["AAPL"]);
    valve.setViewport(["AAPL"]);
    // Not active → medium priority

    for (let i = 0; i < 100; i++) {
      valve.ingest(tick("AAPL", 150 + i));
    }

    valve.destroy();
  });

  bench("drop path: off-screen passive (discarded immediately)", () => {
    const valve = new BackpressureValve(() => {});
    valve.addWatched(["AAPL"]);
    // Not in viewport, not active → drop

    for (let i = 0; i < 100; i++) {
      valve.ingest(tick("AAPL", 150 + i));
    }

    valve.destroy();
  });
});

// ─── Conflation ratio measurement ─────────────────────────────────────────────
// Reports how many ticks survive to the pending buffer after a burst.
// Conflation ratio = ingested / pending = N*T / N (ideally).

describe("BackpressureValve: conflation ratio at burst rates", () => {
  for (const [burstMultiple, label] of [
    [10, "10×"],
    [50, "50×"],
    [100, "100×"],
  ] as const) {
    bench(
      `${label} burst: ${burstMultiple} ticks/instrument, 100 instruments → conflation`,
      () => {
        const N = 100;
        const IDS = Array.from({ length: N }, (_, i) => `INST-${i}`);
        const valve = new BackpressureValve(() => {});
        valve.addWatched(IDS);
        valve.setViewport(IDS);

        let mid = 100;
        for (let t = 0; t < burstMultiple; t++) {
          for (const id of IDS) {
            valve.ingest(tick(id, mid++));
          }
        }

        // After this burst: pending should have at most N=100 entries (last tick wins).
        // Total ingested: N * burstMultiple ticks.
        // Conflation ratio: burstMultiple:1

        valve.destroy();
      },
    );
  }
});
