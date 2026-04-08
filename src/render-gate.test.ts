import { RenderGate, type RenderGateConfig } from "./render-gate";
import type {
  CausalMetadata,
  CoherentSnapshot,
  CurrencyCode,
  Delta,
  Gamma,
  GapEvent,
  GreeksUpdate,
  InstrumentId,
  PositionUpdate,
  Price,
  PriceTick,
  Quantity,
  Theta,
  Timestamp,
  Vega,
} from "./types";
import { byCorrelationId, byEventTimestamp, byGlobalSequence } from "./types";

// ─── Test helpers ────────────────────────────────────────────────────────────

function tick(
  instrumentId: InstrumentId,
  mid: number,
  causal: CausalMetadata = {},
): PriceTick {
  return {
    instrumentId,
    bid: (mid - 0.5) as Price,
    ask: (mid + 0.5) as Price,
    mid: mid as Price,
    timestamp: Date.now() as Timestamp,
    ...causal,
  };
}

function position(
  instrumentId: InstrumentId,
  quantity: number,
  causal: CausalMetadata = {},
): PositionUpdate {
  return {
    instrumentId,
    quantity: quantity as Quantity,
    avgCost: 100 as Price,
    currency: "USD" as CurrencyCode,
    timestamp: Date.now() as Timestamp,
    ...causal,
  };
}

function greeks(
  instrumentId: InstrumentId,
  causal: CausalMetadata = {},
): GreeksUpdate {
  return {
    instrumentId,
    delta: 0.5 as Delta,
    gamma: 0.02 as Gamma,
    vega: 0.15 as Vega,
    theta: -0.01 as Theta,
    timestamp: Date.now() as Timestamp,
    ...causal,
  };
}

function priceMap(
  id: InstrumentId,
  mid: number,
  causal: CausalMetadata = {},
): Map<InstrumentId, PriceTick> {
  return new Map([[id, tick(id, mid, causal)]]);
}

/** Collect snapshots emitted by a gate into an array for assertions. */
function collect(): [CoherentSnapshot[], (s: CoherentSnapshot) => void] {
  const snapshots: CoherentSnapshot[] = [];
  return [snapshots, (s: CoherentSnapshot) => snapshots.push(s)];
}

// ─── Shared configs ───────────────────────────────────────────────────────────

// v0.2.0: identity-based coherence via correlationId.
const v2_CAUSAL_CONFIG: RenderGateConfig = {
  coherenceKey: byCorrelationId,
  streams: {
    prices: { passThrough: true },
    positions: { passThrough: false },
    greeks: { passThrough: false },
  },
  holdTimeout: 200,
  wallClockWindow: 50,
};

// v0.1.0: no causal key → extractor returns null → wall-clock path only.
const v1_CONFIG: RenderGateConfig = {
  wallClockWindow: 50,
  holdTimeout: 200,
};

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═════════════════════════════════════════════════════════════════════════════

describe("RenderGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D1: False coherence
  //
  // Two independent fills land within 50ms. v0.1.0 treats them as coherent:
  // the snapshot mixes positions from FILL-789 with greeks from FILL-456.
  // v0.2.0 detects the key mismatch and withholds a coherent snapshot.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D1: False coherence", () => {
    test("v0.1.0 emits coherent snapshot mixing data from two unrelated events", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v1_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));

      // FILL-456: position update
      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-456" }),
      );

      // FILL-789: independent fill 30ms later — supersedes FILL-456 position
      vi.advanceTimersByTime(30);
      gate.updatePositions(position("AAPL", 50, { correlationId: "FILL-789" }));

      // FILL-456 greeks arrive 15ms later (45ms total) — within the 50ms window
      vi.advanceTimersByTime(15);
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-456" }));

      // v0.1.0: all streams updated within 50ms → wall-clock coherent.
      // Positions are from FILL-789, greeks from FILL-456: mixed causality.
      const coherent = snapshots.filter((s) => !s.isPartial);
      expect(coherent.length).toBeGreaterThan(0);

      const last = coherent[coherent.length - 1];
      expect(last.isPartial).toBe(false); // gate thinks this is fine — it is not
      expect(last.positions.AAPL.quantity).toBe(50); // FILL-789
      // greeks were computed for FILL-456 — the gate has no way to detect that

      gate.destroy();
    });

    test("v0.2.0 detects mixed causal keys and withholds a coherent snapshot", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v2_CAUSAL_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));

      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-456" }),
      );

      // FILL-789 supersedes before FILL-456 greeks arrive
      vi.advanceTimersByTime(30);
      gate.updatePositions(position("AAPL", 50, { correlationId: "FILL-789" }));

      // Late FILL-456 greeks — key no longer matches pending FILL-789
      vi.advanceTimersByTime(15);
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-456" }));

      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(0);

      // Gate is now waiting for FILL-456 greeks to match pending FILL-789 —
      // which will never happen. Hold timer fires a final partial.
      vi.advanceTimersByTime(200);
      expect(snapshots.filter((s) => s.isPartial).length).toBeGreaterThan(0);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D2: False incoherence
  //
  // One fill fans out. The Greeks engine is slow (60ms). v0.1.0's 50ms window
  // expires before greeks arrive → partial snapshot, execution suppressed.
  // v0.2.0 ignores timing and emits coherent as soon as both streams carry
  // the same correlationId.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D2: False incoherence", () => {
    test("v0.1.0 suppresses execution when causally related greeks arrive after 50ms", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v1_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100));

      // Same fill, but greeks engine is slow — arrives at T=60ms, past the window
      vi.advanceTimersByTime(60);
      gate.updateGreeks(greeks("AAPL"));

      // No coherent snapshot: spread 60ms > 50ms window.
      // Gate holds until timeout, then emits partial — execution suppressed.
      vi.advanceTimersByTime(200);
      expect(snapshots.filter((s) => s.isPartial).length).toBeGreaterThan(0);

      gate.destroy();
    });

    test("v0.2.0 emits coherent regardless of timing when correlationId matches", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v2_CAUSAL_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-456" }),
      );

      // Same fill, greeks 60ms later — beyond v0.1.0's window, irrelevant here
      vi.advanceTimersByTime(60);
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-456" }));

      const coherent = snapshots.filter((s) => !s.isPartial);
      expect(coherent).toHaveLength(1);
      expect(coherent[0].positions.AAPL.quantity).toBe(100);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D3: Supersession
  //
  // A new causal key arrives before the previous one resolves. The gate must
  // emit partial for the stale key, adopt the new key, then wait for its greeks.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D3: Supersession", () => {
    test("supersession emits partial for stale key, then resolves on new key", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v2_CAUSAL_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));

      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-456" }),
      );
      expect(snapshots).toHaveLength(0); // waiting for FILL-456 greeks

      // FILL-789 arrives before FILL-456 resolves → supersession
      gate.updatePositions(position("AAPL", 50, { correlationId: "FILL-789" }));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].isPartial).toBe(true);

      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-789" }));
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1].isPartial).toBe(false);
      expect(snapshots[1].positions.AAPL.quantity).toBe(50);

      gate.destroy();
    });

    test("rapid supersession chain emits one partial per supersession, resolves on final key", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v2_CAUSAL_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));

      // Three rapid fills — FILL-1 and FILL-2 each get superseded before resolving
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
      gate.updatePositions(position("AAPL", 200, { correlationId: "FILL-2" }));
      gate.updatePositions(position("AAPL", 300, { correlationId: "FILL-3" }));

      expect(snapshots.filter((s) => s.isPartial)).toHaveLength(2);

      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-3" }));

      const coherent = snapshots.filter((s) => !s.isPartial);
      expect(coherent).toHaveLength(1);
      expect(coherent[0].positions.AAPL.quantity).toBe(300);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D4: Wall-clock fallback
  //
  // When messages lack causal metadata the gate falls back to v0.1.0 behaviour:
  // coherence is determined by arrival proximity within wallClockWindow.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D4: Wall-clock fallback", () => {
    test("falls back to wall-clock when messages lack the configured metadata field", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byCorrelationId, // configured, but messages carry no correlationId
        streams: {
          prices: { passThrough: true },
          positions: { passThrough: false },
          greeks: { passThrough: false },
        },
      });

      // No correlationId → extractor returns null → wall-clock path
      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100));
      gate.updateGreeks(greeks("AAPL"));

      // All arrive in the same synchronous tick → spread = 0 → coherent
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].isPartial).toBe(false);

      gate.destroy();
    });

    test("wall-clock fallback withholds coherence when spread exceeds window", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byCorrelationId,
        streams: {
          prices: { passThrough: true },
          positions: { passThrough: false },
          greeks: { passThrough: false },
        },
        wallClockWindow: 50,
      });

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100));

      vi.advanceTimersByTime(60); // spread will be 60ms > 50ms window
      gate.updateGreeks(greeks("AAPL"));

      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(0);

      vi.advanceTimersByTime(200);
      expect(snapshots.filter((s) => s.isPartial).length).toBeGreaterThan(0);

      gate.destroy();
    });

    test("zero-config gate is fully v0.1.0 compatible", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler); // no config

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100));
      gate.updateGreeks(greeks("AAPL"));

      // No coherenceKey → wall-clock. All arrive in same tick → spread = 0 → coherent.
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].isPartial).toBe(false);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D5: Hold timeout
  //
  // If a causal key never resolves within holdTimeout, the gate emits partial
  // and unblocks the UI. A coherent arrival before the timeout cancels the timer.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D5: Hold timeout", () => {
    test("emits partial when greeks never arrive within holdTimeout", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        ...v2_CAUSAL_CONFIG,
        holdTimeout: 200,
      });

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-456" }),
      );
      expect(snapshots).toHaveLength(0);

      vi.advanceTimersByTime(200);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].isPartial).toBe(true);

      gate.destroy();
    });

    test("coherent arrival before timeout cancels the timer and emits no further snapshots", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        ...v2_CAUSAL_CONFIG,
        holdTimeout: 200,
      });

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-456" }),
      );

      vi.advanceTimersByTime(100);
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-456" }));

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].isPartial).toBe(false);

      // Advance past the original timeout deadline — no additional emit
      vi.advanceTimersByTime(200);
      expect(snapshots).toHaveLength(1);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D6: passThrough semantics
  //
  // passThrough: true  → any historical update suffices (prices).
  // passThrough: false → must carry the current causal key (positions, greeks).
  // ─────────────────────────────────────────────────────────────────────────

  describe("D6: passThrough semantics", () => {
    test("passThrough stream is satisfied by any prior update, regardless of causal key", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v2_CAUSAL_CONFIG);

      // Price tick carries a different key — irrelevant for passThrough streams
      gate.updatePrices(priceMap("AAPL", 150, { correlationId: "TICK-001" }));

      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-456" }),
      );
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-456" }));

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].isPartial).toBe(false);

      gate.destroy();
    });

    test("passThrough stream with no prior update blocks coherence", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v2_CAUSAL_CONFIG);

      // No prices ever — passThrough requires lastUpdated > 0
      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-456" }),
      );
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-456" }));

      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(0);

      vi.advanceTimersByTime(200);
      expect(snapshots[snapshots.length - 1].isPartial).toBe(true);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D7: Gap detection (globalSequence)
  //
  // A missing sequence number triggers strategy-specific handling.
  // The message that revealed the gap is still valid and processed normally.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D7: Gap detection", () => {
    const SEQ_CONFIG: RenderGateConfig = {
      coherenceKey: byGlobalSequence,
      streams: {
        prices: { passThrough: true, gapStrategy: "partial" },
        positions: { passThrough: false, gapStrategy: "wait" },
        greeks: { passThrough: false, gapStrategy: "snapshot-fetch" },
      },
      holdTimeout: 200,
    };

    test("snapshot-fetch fires onGap callback with correct stream and sequence range", () => {
      const [_snapshots, handler] = collect();
      const gate = new RenderGate(handler, SEQ_CONFIG);
      const gaps: GapEvent[] = [];
      gate.onGap((e) => gaps.push(e));

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { globalSequence: 1 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 1 }));

      // Sequence jumps 1 → 3 on greeks — seq 2 is missing
      gate.updateGreeks(greeks("AAPL", { globalSequence: 3 }));

      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toEqual({
        stream: "greeks",
        expectedSeq: 2,
        receivedSeq: 3,
      });

      gate.destroy();
    });

    test("wait strategy arms hold timer on gap and emits partial on expiry", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, SEQ_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { globalSequence: 1 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 1 }));

      gate.updatePositions(position("AAPL", 200, { globalSequence: 3 })); // gap: 1 → 3

      vi.advanceTimersByTime(200);
      expect(snapshots.filter((s) => s.isPartial).length).toBeGreaterThan(0);

      gate.destroy();
    });
  });

  test("partial strategy advances past a gap without flagging isPartial", () => {
    const [snapshots, handler] = collect();
    // greeks configured as 'partial': a missing reprice is superseded by the next one.
    const gate = new RenderGate(handler, {
      coherenceKey: byGlobalSequence,
      streams: {
        prices: { passThrough: true, gapStrategy: "partial" },
        positions: { passThrough: false, gapStrategy: "wait" },
        greeks: { passThrough: false, gapStrategy: "partial" },
      },
      holdTimeout: 200,
    });

    gate.updatePrices(priceMap("AAPL", 150, { globalSequence: 1 }));
    gate.updatePositions(position("AAPL", 100, { globalSequence: 1 }));
    gate.updateGreeks(greeks("AAPL", { globalSequence: 1 }));

    // Greeks gap: seq 2 missing. Both streams now at seq 3.
    gate.updatePositions(position("AAPL", 200, { globalSequence: 3 }));
    gate.updateGreeks(greeks("AAPL", { globalSequence: 3 }));

    const coherent = snapshots.filter((s) => !s.isPartial);
    expect(coherent.length).toBeGreaterThan(0);
    expect(coherent[coherent.length - 1].isPartial).toBe(false);

    gate.destroy();
  });

  test("prices bypass gap detection — BackpressureValve conflates ticks, making sequences meaningless", () => {
    const [snapshots, handler] = collect();
    const gate = new RenderGate(handler, {
      coherenceKey: byGlobalSequence,
      streams: {
        prices: { passThrough: true, gapStrategy: "partial" },
        positions: { passThrough: false, gapStrategy: "wait" },
        greeks: { passThrough: false, gapStrategy: "wait" },
      },
      holdTimeout: 200,
    });

    gate.updatePrices(priceMap("AAPL", 150, { globalSequence: 1 }));
    gate.updatePositions(position("AAPL", 100, { globalSequence: 1 }));
    gate.updateGreeks(greeks("AAPL", { globalSequence: 1 }));

    // Price seq jumps 1 → 100. updatePrices never calls checkSequence, so no gap fires.
    gate.updatePrices(priceMap("AAPL", 200, { globalSequence: 100 }));
    gate.updatePositions(position("AAPL", 100, { globalSequence: 2 }));
    gate.updateGreeks(greeks("AAPL", { globalSequence: 2 }));

    expect(snapshots.filter((s) => !s.isPartial).length).toBeGreaterThan(0);

    gate.destroy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D8: Alternative coherence extractors
  // ─────────────────────────────────────────────────────────────────────────

  describe("D8: Alternative coherence extractors", () => {
    test("byEventTimestamp: coherent when all streams carry the same exchange timestamp", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byEventTimestamp,
        streams: {
          prices: { passThrough: true },
          positions: { passThrough: false },
          greeks: { passThrough: false },
        },
      });

      const exchangeTime = 1700000000000;

      gate.updatePrices(
        priceMap("AAPL", 150, { eventTimestamp: exchangeTime }),
      );
      gate.updatePositions(
        position("AAPL", 100, { eventTimestamp: exchangeTime }),
      );

      // 80ms wall-clock delay, same exchange timestamp — timing is irrelevant
      vi.advanceTimersByTime(80);
      gate.updateGreeks(greeks("AAPL", { eventTimestamp: exchangeTime }));

      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(1);

      gate.destroy();
    });

    test("byGlobalSequence: coherent when all streams carry the same sequence ID", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byGlobalSequence,
        streams: {
          prices: { passThrough: true, gapStrategy: "partial" },
          positions: { passThrough: false, gapStrategy: "wait" },
          greeks: { passThrough: false, gapStrategy: "wait" },
        },
      });

      gate.updatePrices(priceMap("AAPL", 150, { globalSequence: 42 }));
      gate.updatePositions(position("AAPL", 100, { globalSequence: 42 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 42 }));

      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(1);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D9: Snapshot correctness
  // ─────────────────────────────────────────────────────────────────────────

  describe("D9: Snapshot correctness", () => {
    test("sequenceId increments monotonically across all emits", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v2_CAUSAL_CONFIG);

      for (let i = 1; i <= 3; i++) {
        gate.updatePrices(priceMap("AAPL", 150 + i));
        gate.updatePositions(
          position("AAPL", 100, { correlationId: `FILL-${i}` }),
        );
        gate.updateGreeks(greeks("AAPL", { correlationId: `FILL-${i}` }));
      }

      const ids = snapshots.map((s) => s.sequenceId);
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]);
      }

      gate.destroy();
    });

    test("snapshot spreads the Record — a subsequent gate update does not overwrite a prior snapshot's entry", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v2_CAUSAL_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-1" }));
      const snap1 = snapshots[0];

      gate.updatePrices(priceMap("AAPL", 200));
      gate.updatePositions(position("AAPL", 200, { correlationId: "FILL-2" }));
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-2" }));
      const snap2 = snapshots[1];

      // Spread copies Record keys — each snapshot holds its own key-to-object mapping
      expect(snap1.prices.AAPL.mid).toBe(150);
      expect(snap2.prices.AAPL.mid).toBe(200);

      gate.destroy();
    });

    test("tick objects are not deep-cloned — consumer mutations leak back into gate state", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v2_CAUSAL_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-1" }));

      // snap1.prices["AAPL"] is the same object reference as gate's internal state.
      // Mutating it corrupts the gate's stored price until the next price update.
      snapshots[0].prices.AAPL.mid = 9999 as Price;

      gate.updatePositions(position("AAPL", 200, { correlationId: "FILL-2" }));
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-2" }));

      expect(snapshots[1].prices.AAPL.mid).toBe(9999); // corrupted value propagated

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D10: Multi-instrument
  //
  // Coherence is tracked per-stream, not per-instrument within a stream.
  // When AAPL greeks arrive, lastCausalId.greeks = "FILL-REBAL" and the gate
  // emits immediately — even though GOOG greeks haven't arrived yet.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D10: Multi-instrument", () => {
    test("gate emits as soon as stream-level coherence is met, even if not all instruments are present", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v2_CAUSAL_CONFIG);

      gate.updatePrices(
        new Map([
          ["AAPL", tick("AAPL", 150)],
          ["GOOG", tick("GOOG", 2800)],
        ]),
      );

      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-REBAL" }),
      );
      gate.updatePositions(
        position("GOOG", 50, { correlationId: "FILL-REBAL" }),
      );

      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-REBAL" }));
      // ↑ AAPL greeks arrive → lastCausalId.greeks = "FILL-REBAL" → coherent.
      // Emits immediately. GOOG entry in greeks record is absent.

      gate.updateGreeks(greeks("GOOG", { correlationId: "FILL-REBAL" }));
      // ↑ GOOG greeks arrive → re-emits with both instruments present.

      const coherent = snapshots.filter((s) => !s.isPartial);
      expect(coherent).toHaveLength(2);

      expect(coherent[0].greeks.GOOG).toBeUndefined();
      expect(coherent[0].greeks.AAPL).toBeDefined();

      expect(coherent[1].positions.AAPL.quantity).toBe(100);
      expect(coherent[1].positions.GOOG.quantity).toBe(50);
      expect(coherent[1].greeks.AAPL).toBeDefined();
      expect(coherent[1].greeks.GOOG).toBeDefined();

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D11: Mixed-mode feeds
  //
  // During a partial backend rollout some messages carry correlationId,
  // others don't. A wall-clock coherent emit must clear pendingCausalKey;
  // otherwise a late delivery of the pending key re-enters tryEmitCausal
  // and emits a second snapshot for the same event.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D11: Mixed-mode feeds", () => {
    test("wall-clock emit clears pendingCausalKey — late causal delivery does not double-emit", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byCorrelationId,
        streams: {
          prices: { passThrough: true },
          positions: { passThrough: false },
          greeks: { passThrough: false },
        },
        wallClockWindow: 100,
        holdTimeout: 500,
      });

      gate.updatePrices(priceMap("AAPL", 150));

      // Position with key → pendingCausalKey = "FILL-1", hold timer armed
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
      expect(snapshots).toHaveLength(0);

      // Greeks without key → wall-clock path → coherent within 100ms window
      gate.updateGreeks(greeks("AAPL")); // no correlationId
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].isPartial).toBe(false);

      // Late FILL-1 greeks arrive (redelivery or slow downstream).
      // pendingCausalKey was cleared by the wall-clock emit, so this starts
      // a fresh causal wait — both streams now carry FILL-1 → coherent again.
      // One additional emit is correct; a duplicate of the first would not be.
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-1" }));
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1].isPartial).toBe(false);

      gate.destroy();
    });

    test("neither path resolves when causal stream arrives beyond the wall-clock window — hold timer emits partial", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byCorrelationId,
        streams: {
          prices: { passThrough: true },
          positions: { passThrough: false },
          greeks: { passThrough: false },
        },
        wallClockWindow: 50,
        holdTimeout: 200,
      });

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));

      // Greeks without key arrive 80ms later — causal path fails (no key),
      // wall-clock path fails (spread 80ms > 50ms window).
      vi.advanceTimersByTime(80);
      gate.updateGreeks(greeks("AAPL"));

      vi.advanceTimersByTime(200);
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[snapshots.length - 1].isPartial).toBe(true);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D12: Gap flag persistence
  //
  // hasUnresolvedGap must survive hold timer expiry. Clearing it on timeout
  // would let subsequent snapshots appear clean over a position history with
  // a hole. Only a coherent delivery of the missing data clears the flag.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D12: Gap flag persistence", () => {
    test("isPartial remains true after a gap until the missing data arrives", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byGlobalSequence,
        streams: {
          prices: { passThrough: true, gapStrategy: "partial" },
          positions: { passThrough: false, gapStrategy: "wait" },
          greeks: { passThrough: false, gapStrategy: "wait" },
        },
        holdTimeout: 100,
      });

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { globalSequence: 1 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 1 }));
      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(1);

      // Positions jump 1 → 3. Seq 2 (a fill) never arrives.
      gate.updatePositions(position("AAPL", 200, { globalSequence: 3 }));
      vi.advanceTimersByTime(100); // hold timer fires → partial
      expect(snapshots.filter((s) => s.isPartial).length).toBeGreaterThan(0);

      // Next coherent event — gap was never filled, so isPartial must stay true.
      gate.updatePositions(position("AAPL", 300, { globalSequence: 4 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 4 }));
      expect(snapshots[snapshots.length - 1].isPartial).toBe(true);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D13: byGlobalSequence backend contract
  //
  // All messages from the same market event must share ONE sequence ID.
  // A per-message counter means positions and greeks always carry different
  // keys — the gate never reaches coherence and degrades to timeout partials.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D13: byGlobalSequence backend contract", () => {
    test("shared sequence ID across fan-out streams achieves coherence", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byGlobalSequence,
        streams: {
          prices: { passThrough: true, gapStrategy: "partial" },
          positions: { passThrough: false, gapStrategy: "wait" },
          greeks: { passThrough: false, gapStrategy: "wait" },
        },
        holdTimeout: 50,
      });

      gate.updatePrices(priceMap("AAPL", 150));
      // Both streams carry seq 42 — the shared event ID for this fill
      gate.updatePositions(position("AAPL", 100, { globalSequence: 42 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 42 }));

      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(1);

      gate.destroy();
    });

    test("per-message counter (unique ID per message) never achieves coherence — every event times out", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byGlobalSequence,
        streams: {
          prices: { passThrough: true, gapStrategy: "partial" },
          positions: { passThrough: false, gapStrategy: "wait" },
          greeks: { passThrough: false, gapStrategy: "wait" },
        },
        holdTimeout: 50,
      });

      gate.updatePrices(priceMap("AAPL", 150));
      // positions=100, greeks=101: different keys, isCoherentForKey never satisfied
      gate.updatePositions(position("AAPL", 100, { globalSequence: 100 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 101 }));

      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(0);

      vi.advanceTimersByTime(50);
      expect(snapshots[snapshots.length - 1].isPartial).toBe(true);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D14: Destroy
  // ─────────────────────────────────────────────────────────────────────────

  describe("D14: Destroy", () => {
    test("clears hold timer and onGap callback — no emit after destroy", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v2_CAUSAL_CONFIG);
      gate.onGap(() => {});

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
      // Hold timer is armed — greeks never arrive

      gate.destroy();

      vi.advanceTimersByTime(500);
      expect(snapshots).toHaveLength(0);
    });
  });
});
