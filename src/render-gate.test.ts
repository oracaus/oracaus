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

// v0.3.0: identity-based coherence via correlationId.
const v3_CAUSAL_CONFIG: RenderGateConfig = {
  coherenceKey: byCorrelationId,
  anchorStream: "positions",
  streams: {
    prices: { passThrough: true },
    positions: { passThrough: false },
    greeks: { passThrough: false },
  },
  holdTimeout: 200,
  wallClockWindow: 50,
};

// v0.1.0: no causal key → extractor returns null → wall-clock path only.
// anchorStream is required in v0.4.0 even though the wall-clock path ignores it.
const v1_CONFIG: RenderGateConfig = {
  anchorStream: "positions",
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
  // v0.3.0 detects the key mismatch and withholds a coherent snapshot.
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

    test("v0.3.0 detects mixed causal keys and withholds a coherent snapshot", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

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

      // Gate is now waiting for greeks with "FILL-456" to match pending "FILL-789"
      // (or vice versa) — which will never happen. Hold timer fires a partial.
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
  // v0.3.0 ignores timing and emits coherent as soon as both streams carry
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

    test("v0.3.0 emits coherent regardless of timing when correlationId matches", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

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
      expect(coherent[0].coherentInstruments.has("AAPL")).toBe(true);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D3: Supersession (v0.3.0 semantics)
  //
  // A new causal key arrives before the previous one resolves. In v0.3.0,
  // supersession is silent — no immediate partial emit. The old key is
  // replaced per-instrument and a new wait begins. The gate emits coherent
  // when the new key resolves. isPartial stays false unless a timer fires.
  //
  // Rationale: with per-instrument tracking, supersession for AAPL does not
  // affect GOOG. Emitting a partial immediately would cause spurious UI updates
  // during rebalances where hundreds of instruments are superseded simultaneously.
  // The coherentInstruments set already signals "AAPL is in-flight" implicitly
  // on the next snapshot (AAPL would be absent from coherentInstruments).
  // ─────────────────────────────────────────────────────────────────────────

  describe("D3: Supersession", () => {
    test("supersession replaces the pending key silently and resolves on the new key", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));

      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-456" }),
      );
      expect(snapshots).toHaveLength(0); // waiting for FILL-456 greeks

      // FILL-789 supersedes FILL-456 — no partial emit in v0.3.0
      gate.updatePositions(position("AAPL", 50, { correlationId: "FILL-789" }));
      expect(snapshots).toHaveLength(0); // still silent; now waiting for FILL-789 greeks

      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-789" }));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].isPartial).toBe(false);
      expect(snapshots[0].positions.AAPL.quantity).toBe(50);
      expect(snapshots[0].coherentInstruments.has("AAPL")).toBe(true);

      gate.destroy();
    });

    test("stale greeks after supersession do not resolve the gate — only the winning key does", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));

      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
      gate.updatePositions(position("AAPL", 200, { correlationId: "FILL-2" }));
      gate.updatePositions(position("AAPL", 300, { correlationId: "FILL-3" }));

      // FILL-1 and FILL-2 greeks — stale relative to pending FILL-3
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-1" }));
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-2" }));

      // No coherent emit yet — lastCausalId.greeks.AAPL = "FILL-2", pending = "FILL-3"
      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(0);

      // FILL-3 greeks arrive — matches pending key
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-3" }));

      const coherent = snapshots.filter((s) => !s.isPartial);
      expect(coherent).toHaveLength(1);
      expect(coherent[0].positions.AAPL.quantity).toBe(300);
      expect(coherent[0].coherentInstruments.has("AAPL")).toBe(true);

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
        anchorStream: "positions",
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
        anchorStream: "positions",
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

    test("minimal-config gate (anchorStream only) is fully v0.1.0 compatible", () => {
      const [snapshots, handler] = collect();
      // v0.4.0 requires anchorStream; no coherenceKey still selects the wall-clock path.
      const gate = new RenderGate(handler, { anchorStream: "positions" });

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
        ...v3_CAUSAL_CONFIG,
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
        ...v3_CAUSAL_CONFIG,
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
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

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
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

      // No prices ever — passThrough requires instrument entry to exist
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
  // Gap events now include instrumentId (per-instrument tracking).
  // ─────────────────────────────────────────────────────────────────────────

  describe("D7: Gap detection", () => {
    const SEQ_CONFIG: RenderGateConfig = {
      coherenceKey: byGlobalSequence,
      anchorStream: "positions",
      streams: {
        prices: { passThrough: true, gapStrategy: "partial" },
        positions: { passThrough: false, gapStrategy: "wait" },
        greeks: { passThrough: false, gapStrategy: "snapshot-fetch" },
      },
      holdTimeout: 200,
    };

    test("snapshot-fetch fires onGap callback with correct stream, instrument, and sequence range", () => {
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
        instrumentId: "AAPL",
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

    test("wait strategy recovers coherence when the missing sequence eventually arrives", () => {
      // Gap declared → hold timer armed → missing seq arrives before timeout →
      // first coherent emit is isPartial: true (gap acknowledged once), subsequent clean.
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byGlobalSequence,
        anchorStream: "positions",
        streams: {
          prices: { passThrough: true, gapStrategy: "partial" },
          positions: { passThrough: false, gapStrategy: "wait" },
          greeks: { passThrough: false, gapStrategy: "wait" },
        },
        holdTimeout: 200,
      });

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { globalSequence: 1 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 1 }));
      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(1);

      // Positions jump 1 → 3. Seq 2 is the missing fill.
      gate.updatePositions(position("AAPL", 200, { globalSequence: 3 }));
      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(1); // no new coherent emit

      // Greeks seq 3 arrives — both non-passThrough streams now at key "3" → coherent.
      // hasUnresolvedGaps is set → first delivery after gap is isPartial: true.
      gate.updateGreeks(greeks("AAPL", { globalSequence: 3 }));
      expect(snapshots[snapshots.length - 1].isPartial).toBe(true);

      // Gap flag consumed. Next fill is clean.
      gate.updatePositions(position("AAPL", 300, { globalSequence: 4 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 4 }));
      expect(snapshots[snapshots.length - 1].isPartial).toBe(false);

      gate.destroy();
    });

    test("snapshot-fetch strategy arms hold timer and marks first coherent recovery as partial", () => {
      // onGap fires AND hold timer is armed. If recovery arrives before timeout,
      // the first coherent emit is isPartial: true (gap acknowledged). Subsequent clean.
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, SEQ_CONFIG); // greeks: snapshot-fetch
      const gaps: GapEvent[] = [];
      gate.onGap((e) => gaps.push(e));

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { globalSequence: 1 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 1 }));
      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(1);

      // Greeks gap 1 → 3: onGap fires (snapshot-fetch), hold timer armed.
      gate.updateGreeks(greeks("AAPL", { globalSequence: 3 }));
      expect(gaps).toHaveLength(1);
      expect(gaps[0].stream).toBe("greeks");

      // Positions seq 3 arrives — both streams at key "3" → coherent.
      // hasUnresolvedGaps still set → isPartial: true (gap acknowledged).
      gate.updatePositions(position("AAPL", 200, { globalSequence: 3 }));
      expect(snapshots[snapshots.length - 1].isPartial).toBe(true);

      // Gap flag consumed. Next fill is clean.
      gate.updatePositions(position("AAPL", 300, { globalSequence: 4 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 4 }));
      expect(snapshots[snapshots.length - 1].isPartial).toBe(false);

      gate.destroy();
    });

    test("partial strategy advances past a gap without flagging isPartial", () => {
      const [snapshots, handler] = collect();
      // greeks configured as 'partial': a missing reprice is superseded by the next one.
      const gate = new RenderGate(handler, {
        coherenceKey: byGlobalSequence,
        anchorStream: "positions",
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
        anchorStream: "positions",
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
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D8: Alternative coherence extractors
  // ─────────────────────────────────────────────────────────────────────────

  describe("D8: Alternative coherence extractors", () => {
    test("byEventTimestamp: coherent when all streams carry the same exchange timestamp", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byEventTimestamp,
        anchorStream: "positions",
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
        anchorStream: "positions",
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
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

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
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

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
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

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

    test("coherentInstruments is a ReadonlySet in the snapshot", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-1" }));

      expect(snapshots[0].coherentInstruments).toBeInstanceOf(Set);
      expect(snapshots[0].coherentInstruments.has("AAPL")).toBe(true);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D10: Multi-instrument (v0.3.0 per-instrument semantics)
  //
  // v0.3.0 tracks causal state per instrument. When AAPL greeks arrive,
  // the gate checks AAPL-specific coherence — not stream-level. AAPL emits
  // as coherent immediately; GOOG emits as coherent when its greeks arrive.
  // Each emit has an accurate coherentInstruments set.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D10: Multi-instrument", () => {
    test("gate emits per-instrument coherence — AAPL resolves before GOOG, each emit reflects accurate state", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

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

      // AAPL greeks arrive first — AAPL achieves per-instrument coherence
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-REBAL" }));

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].coherentInstruments.has("AAPL")).toBe(true);
      expect(snapshots[0].coherentInstruments.has("GOOG")).toBe(false); // still pending
      expect(snapshots[0].isPartial).toBe(false); // no timer fired

      // GOOG greeks arrive — GOOG achieves coherence; second emit
      gate.updateGreeks(greeks("GOOG", { correlationId: "FILL-REBAL" }));

      expect(snapshots).toHaveLength(2);
      expect(snapshots[1].coherentInstruments.has("AAPL")).toBe(true);
      expect(snapshots[1].coherentInstruments.has("GOOG")).toBe(true);
      expect(snapshots[1].isPartial).toBe(false);

      expect(snapshots[1].positions.AAPL.quantity).toBe(100);
      expect(snapshots[1].positions.GOOG.quantity).toBe(50);

      gate.destroy();
    });

    test("independent fills for different instruments resolve independently without interfering", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

      gate.updatePrices(
        new Map([
          ["AAPL", tick("AAPL", 150)],
          ["GOOG", tick("GOOG", 2800)],
        ]),
      );

      // AAPL fill and GOOG fill are independent — different correlationIds
      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-456" }),
      );
      gate.updatePositions(position("GOOG", 50, { correlationId: "FILL-789" }));

      // AAPL greeks for FILL-456 — AAPL coherent; GOOG still pending
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-456" }));

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].coherentInstruments.has("AAPL")).toBe(true);
      expect(snapshots[0].coherentInstruments.has("GOOG")).toBe(false);

      // GOOG greeks for FILL-789 — GOOG coherent
      gate.updateGreeks(greeks("GOOG", { correlationId: "FILL-789" }));

      expect(snapshots).toHaveLength(2);
      expect(snapshots[1].coherentInstruments.has("AAPL")).toBe(true);
      expect(snapshots[1].coherentInstruments.has("GOOG")).toBe(true);
      expect(snapshots[1].isPartial).toBe(false);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D11: Mixed-mode feeds
  //
  // During a partial backend rollout some messages carry correlationId,
  // others don't. A wall-clock coherent emit must clear pendingCausalKeys
  // for all instruments; otherwise a late delivery of the pending key
  // re-enters tryEmitCausal and emits a second snapshot for the same event.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D11: Mixed-mode feeds", () => {
    test("wall-clock emit clears pendingCausalKeys — late causal delivery does not double-emit", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byCorrelationId,
        anchorStream: "positions",
        streams: {
          prices: { passThrough: true },
          positions: { passThrough: false },
          greeks: { passThrough: false },
        },
        wallClockWindow: 100,
        holdTimeout: 500,
      });

      gate.updatePrices(priceMap("AAPL", 150));

      // Position with key → pendingCausalKey for AAPL = "FILL-1", hold timer armed
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
      expect(snapshots).toHaveLength(0);

      // Greeks without key → wall-clock path → coherent within 100ms window
      gate.updateGreeks(greeks("AAPL")); // no correlationId
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].isPartial).toBe(false);

      // Late FILL-1 greeks arrive. pendingCausalKeys was cleared by wall-clock emit.
      // This starts a fresh causal wait — both streams now carry FILL-1 → coherent again.
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
        anchorStream: "positions",
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
  // D12: Gap flag persistence (per-instrument)
  //
  // hasUnresolvedGaps must survive hold timer expiry per instrument. Clearing
  // it on timeout would let subsequent snapshots appear clean over a position
  // history with a hole. Only a coherent delivery of the missing data clears
  // the flag — and that first coherent delivery after the gap is still marked
  // isPartial so consumers know history has a hole.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D12: Gap flag persistence", () => {
    test("isPartial marks the first coherent emit after a gap; subsequent emits are clean", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byGlobalSequence,
        anchorStream: "positions",
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

      // Next coherent event carries the unresolved gap flag — still isPartial.
      gate.updatePositions(position("AAPL", 300, { globalSequence: 4 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 4 }));
      expect(snapshots[snapshots.length - 1].isPartial).toBe(true);

      // Gap flag was consumed by the above emit. The NEXT coherent event is clean.
      gate.updatePositions(position("AAPL", 400, { globalSequence: 5 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 5 }));
      expect(snapshots[snapshots.length - 1].isPartial).toBe(false);

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
        anchorStream: "positions",
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
        anchorStream: "positions",
        streams: {
          prices: { passThrough: true, gapStrategy: "partial" },
          positions: { passThrough: false, gapStrategy: "wait" },
          greeks: { passThrough: false, gapStrategy: "wait" },
        },
        holdTimeout: 50,
      });

      gate.updatePrices(priceMap("AAPL", 150));
      // positions=100, greeks=101: different keys, isInstrumentCoherent never satisfied
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
    test("clears all per-instrument hold timers and onGap callback — no emit after destroy", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);
      gate.onGap(() => {});

      gate.updatePrices(priceMap("AAPL", 150));
      gate.updatePositions(position("AAPL", 100, { correlationId: "FILL-1" }));
      gate.updatePrices(priceMap("GOOG", 2800));
      gate.updatePositions(position("GOOG", 50, { correlationId: "FILL-2" }));
      // Hold timers for both AAPL and GOOG are armed — greeks never arrive

      gate.destroy();

      vi.advanceTimersByTime(500);
      expect(snapshots).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D15: Cross-instrument independence
  //
  // The core v0.3.0 correctness proof: AAPL on "FILL-456" and GOOG on
  // "FILL-789" resolve independently. In v0.2.0, these would cause mutual
  // supersession and neither would ever reach coherence.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D15: Cross-instrument independence", () => {
    test("AAPL and GOOG with independent fills each resolve to full coherence without interfering", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, v3_CAUSAL_CONFIG);

      gate.updatePrices(
        new Map([
          ["AAPL", tick("AAPL", 150)],
          ["GOOG", tick("GOOG", 2800)],
        ]),
      );

      // Independent fills — different correlationIds
      gate.updatePositions(
        position("AAPL", 100, { correlationId: "FILL-456" }),
      );
      gate.updatePositions(position("GOOG", 50, { correlationId: "FILL-789" }));

      // Both gates wait independently — no interference, no timer fires
      expect(snapshots).toHaveLength(0);

      vi.advanceTimersByTime(60);
      gate.updateGreeks(greeks("AAPL", { correlationId: "FILL-456" }));
      // AAPL coherent; GOOG still pending
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].coherentInstruments.has("AAPL")).toBe(true);
      expect(snapshots[0].coherentInstruments.has("GOOG")).toBe(false);
      expect(snapshots[0].isPartial).toBe(false);

      vi.advanceTimersByTime(20);
      gate.updateGreeks(greeks("GOOG", { correlationId: "FILL-789" }));
      // GOOG coherent
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1].coherentInstruments.has("AAPL")).toBe(true);
      expect(snapshots[1].coherentInstruments.has("GOOG")).toBe(true);
      expect(snapshots[1].isPartial).toBe(false);

      // Verify data integrity — no cross-contamination
      expect(snapshots[1].positions.AAPL.quantity).toBe(100);
      expect(snapshots[1].positions.GOOG.quantity).toBe(50);

      gate.destroy();
    });

    test("500 instruments with independent fills all resolve without timer expiry", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        ...v3_CAUSAL_CONFIG,
        holdTimeout: 200,
      });

      // Seed prices for all instruments
      const priceEntries = Array.from({ length: 500 }, (_, i) => [
        `INST-${i}`,
        tick(`INST-${i}`, 100 + i),
      ]) as [string, PriceTick][];
      gate.updatePrices(new Map(priceEntries));

      // 500 independent fills
      for (let i = 0; i < 500; i++) {
        gate.updatePositions(
          position(`INST-${i}`, i + 1, { correlationId: `FILL-${i}` }),
        );
      }

      expect(snapshots).toHaveLength(0); // all waiting for greeks

      // Greeks resolve in a different order
      for (let i = 499; i >= 0; i--) {
        gate.updateGreeks(greeks(`INST-${i}`, { correlationId: `FILL-${i}` }));
      }

      // No timer should have fired — all resolved via causal path
      expect(snapshots.filter((s) => s.isPartial)).toHaveLength(0);
      // Every emit should show more instruments coherent than the last
      const lastSnapshot = snapshots[snapshots.length - 1];
      expect(lastSnapshot.coherentInstruments.size).toBe(500);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D16: Mixed-latency blotter
  //
  // In a real blotter, different instruments have different Greeks computation
  // latencies. Fast instruments appear in coherentInstruments before slow ones.
  // The slow instruments' timers do not affect the fast instruments' snapshots.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D16: Mixed-latency blotter", () => {
    test("fast instruments appear coherent before slow ones; slow instruments emit partial on timeout without affecting fast instruments", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        ...v3_CAUSAL_CONFIG,
        holdTimeout: 100,
      });

      const FAST = ["FAST-0", "FAST-1", "FAST-2", "FAST-3", "FAST-4"];
      const SLOW = ["SLOW-0", "SLOW-1", "SLOW-2", "SLOW-3", "SLOW-4"];

      // Seed prices
      gate.updatePrices(
        new Map([
          ...FAST.map((id) => [id, tick(id, 100)] as [string, PriceTick]),
          ...SLOW.map((id) => [id, tick(id, 200)] as [string, PriceTick]),
        ]),
      );

      // All positions arrive simultaneously
      for (const id of [...FAST, ...SLOW]) {
        gate.updatePositions(position(id, 10, { correlationId: `FILL-${id}` }));
      }

      // Fast instruments' Greeks arrive at T=10ms
      vi.advanceTimersByTime(10);
      for (const id of FAST) {
        gate.updateGreeks(greeks(id, { correlationId: `FILL-${id}` }));
      }

      // Fast instruments should now be coherent; slow still pending
      expect(snapshots.length).toBeGreaterThan(0);
      const afterFast = snapshots[snapshots.length - 1];
      for (const id of FAST) {
        expect(afterFast.coherentInstruments.has(id)).toBe(true);
      }
      for (const id of SLOW) {
        expect(afterFast.coherentInstruments.has(id)).toBe(false);
      }
      expect(afterFast.isPartial).toBe(false); // no timer fired

      // Slow instruments time out at T=110ms
      vi.advanceTimersByTime(100);
      const afterTimeout = snapshots[snapshots.length - 1];
      expect(afterTimeout.isPartial).toBe(true); // slow instruments timed out

      // Fast instruments remain coherent in the partial snapshot
      for (const id of FAST) {
        expect(afterTimeout.coherentInstruments.has(id)).toBe(true);
      }

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D17: Monotonic freshness under byEventTimestamp
  //
  // Greeks newer than position → coherent. The v0.3.0 equality rule would
  // withhold; v0.4.0 accepts greeks.key >= position.key on ordered extractors.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D17: Monotonic freshness under byEventTimestamp", () => {
    test("greeks newer than position resolves coherent", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byEventTimestamp,
        anchorStream: "positions",
        streams: {
          prices: { passThrough: true },
          positions: { passThrough: false, freshness: "match" },
          greeks: { passThrough: false, freshness: "monotonic" },
        },
      });

      gate.updatePrices(priceMap("AAPL", 150, { eventTimestamp: 1000 }));
      gate.updatePositions(position("AAPL", 100, { eventTimestamp: 1000 }));
      // Greeks at a later timestamp — valid under monotonic, rejected under match
      gate.updateGreeks(greeks("AAPL", { eventTimestamp: 2500 }));

      const coherent = snapshots.filter((s) => !s.isPartial);
      expect(coherent).toHaveLength(1);
      expect(coherent[0].coherentInstruments.has("AAPL")).toBe(true);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D18: Monotonic freshness under byGlobalSequence
  //
  // Greeks sequence > position sequence → coherent. Gap detection and
  // freshness are orthogonal: a monotonic key still needs to pass.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D18: Monotonic freshness under byGlobalSequence", () => {
    test("greeks at seq > position seq resolves coherent", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byGlobalSequence,
        anchorStream: "positions",
        streams: {
          prices: { passThrough: true, gapStrategy: "partial" },
          positions: {
            passThrough: false,
            gapStrategy: "wait",
            freshness: "match",
          },
          greeks: {
            passThrough: false,
            gapStrategy: "wait",
            freshness: "monotonic",
          },
        },
      });

      gate.updatePrices(priceMap("AAPL", 150, { globalSequence: 100 }));
      gate.updatePositions(position("AAPL", 100, { globalSequence: 100 }));
      gate.updateGreeks(greeks("AAPL", { globalSequence: 101 }));

      const coherent = snapshots.filter((s) => !s.isPartial);
      expect(coherent).toHaveLength(1);
      expect(coherent[0].coherentInstruments.has("AAPL")).toBe(true);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D19: Monotonic — negative case
  //
  // Greeks older than position → still withheld. Proves monotonic hasn't
  // relaxed into "accept anything"; the lower-bound constraint holds.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D19: Monotonic — greeks older than position withheld", () => {
    test("greeks at older timestamp than position does not become coherent", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byEventTimestamp,
        anchorStream: "positions",
        streams: {
          prices: { passThrough: true },
          positions: { passThrough: false, freshness: "match" },
          greeks: { passThrough: false, freshness: "monotonic" },
        },
      });

      gate.updatePrices(priceMap("AAPL", 150, { eventTimestamp: 1000 }));
      vi.advanceTimersByTime(60); // push wall-clock spread past the 50ms fallback window
      gate.updateGreeks(greeks("AAPL", { eventTimestamp: 500 })); // pre-position
      vi.advanceTimersByTime(60);
      gate.updatePositions(position("AAPL", 100, { eventTimestamp: 1000 }));

      // No coherent emit yet — greeks is behind the anchor.
      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(0);

      // Timer fires → partial, AAPL omitted.
      vi.advanceTimersByTime(250);
      const last = snapshots[snapshots.length - 1];
      expect(last.isPartial).toBe(true);
      expect(last.coherentInstruments.has("AAPL")).toBe(false);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D20: Greeks-before-position arrival order under monotonic
  //
  // Greeks arrives first with a newer key; position catches up with a key
  // ≤ buffered greeks. Coherence resolves on position arrival.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D20: Monotonic — greeks-before-position arrival order", () => {
    test("greeks arrives first, position catches up with older key, coherent", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byEventTimestamp,
        anchorStream: "positions",
        streams: {
          prices: { passThrough: true },
          positions: { passThrough: false, freshness: "match" },
          greeks: { passThrough: false, freshness: "monotonic" },
        },
      });

      gate.updatePrices(priceMap("AAPL", 150, { eventTimestamp: 500 }));
      gate.updateGreeks(greeks("AAPL", { eventTimestamp: 2000 }));
      // No coherent emit yet — anchor has no key.
      expect(snapshots.filter((s) => !s.isPartial)).toHaveLength(0);

      gate.updatePositions(position("AAPL", 100, { eventTimestamp: 1000 }));

      const coherent = snapshots.filter((s) => !s.isPartial);
      expect(coherent).toHaveLength(1);
      expect(coherent[0].coherentInstruments.has("AAPL")).toBe(true);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D21: Hold timer behaviour under monotonic
  //
  // Anchor advances while dependent lags → exactly one timer pending at a
  // time. Dependent catches up → timer cancelled, no partial emit.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D21: Monotonic — hold timer cancellation on catch-up", () => {
    test("anchor advances, dependent catches up, timer cancelled", () => {
      const [snapshots, handler] = collect();
      const gate = new RenderGate(handler, {
        coherenceKey: byEventTimestamp,
        anchorStream: "positions",
        streams: {
          prices: { passThrough: true },
          positions: { passThrough: false, freshness: "match" },
          greeks: { passThrough: false, freshness: "monotonic" },
        },
      });

      gate.updatePrices(priceMap("AAPL", 150, { eventTimestamp: 1000 }));
      gate.updatePositions(position("AAPL", 100, { eventTimestamp: 1000 }));
      gate.updateGreeks(greeks("AAPL", { eventTimestamp: 1000 }));
      const initialCoherentCount = snapshots.filter((s) => !s.isPartial).length;
      expect(initialCoherentCount).toBe(1);

      // Anchor advances → dependent stale under monotonic; gate arms a timer
      // but does not emit (supersession is silent in v0.3.0+).
      gate.updatePositions(position("AAPL", 110, { eventTimestamp: 2000 }));
      expect(snapshots.length).toBe(initialCoherentCount); // no new emit

      // Dependent catches up before timeout → cancel timer, emit coherent.
      vi.advanceTimersByTime(50);
      gate.updateGreeks(greeks("AAPL", { eventTimestamp: 2500 }));

      const last = snapshots[snapshots.length - 1];
      expect(last.isPartial).toBe(false);
      expect(last.coherentInstruments.has("AAPL")).toBe(true);

      // Advance past original holdTimeout — no partial emit should fire.
      const emitCountBefore = snapshots.length;
      vi.advanceTimersByTime(300);
      expect(snapshots.length).toBe(emitCountBefore);

      gate.destroy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D22: Runtime rejection — freshness: "monotonic" with byCorrelationId
  //
  // Type-level narrowing of freshness per extractor is a planned refinement;
  // the gate refuses the invalid combination at construction time so the
  // invariant holds regardless of how the config is assembled.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D22: Validation — monotonic with byCorrelationId", () => {
    test("construction throws when monotonic freshness has no ordering", () => {
      expect(
        () =>
          new RenderGate(() => {}, {
            coherenceKey: byCorrelationId,
            anchorStream: "positions",
            streams: {
              prices: { passThrough: true },
              positions: { passThrough: false, freshness: "match" },
              greeks: { passThrough: false, freshness: "monotonic" },
            },
          }),
      ).toThrow(/requires an ordered coherence key extractor/);
    });

    test("construction throws when anchorStream is omitted entirely", () => {
      expect(
        () =>
          // @ts-expect-error — anchorStream is required in v0.4.0
          new RenderGate(() => {}, {
            coherenceKey: byEventTimestamp,
            streams: {
              prices: { passThrough: true },
              positions: { passThrough: false, freshness: "match" },
              greeks: { passThrough: false, freshness: "monotonic" },
            },
          }),
      ).toThrow(/not a declared stream/);
    });

    test("construction throws when monotonic freshness is set on a passThrough stream", () => {
      // freshness has no effect on passThrough streams (valid-until-superseded);
      // the combination is a config bug, so the gate rejects it at construction.
      expect(
        () =>
          new RenderGate(() => {}, {
            coherenceKey: byEventTimestamp,
            anchorStream: "positions",
            streams: {
              prices: { passThrough: true, freshness: "monotonic" },
              positions: { passThrough: false, freshness: "match" },
              greeks: { passThrough: false, freshness: "match" },
            },
          }),
      ).toThrow(/passThrough/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D23: Runtime rejection — anchorStream pointing at passThrough or unknown
  //
  // The anchor must be a declared non-passThrough stream. Both error paths
  // are validated at construction.
  // ─────────────────────────────────────────────────────────────────────────

  describe("D23: Validation — anchorStream constraints", () => {
    test("construction throws when anchorStream is passThrough", () => {
      expect(
        () =>
          new RenderGate(() => {}, {
            coherenceKey: byEventTimestamp,
            anchorStream: "prices",
            streams: {
              prices: { passThrough: true },
              positions: { passThrough: false, freshness: "match" },
              greeks: { passThrough: false, freshness: "monotonic" },
            },
          }),
      ).toThrow(/passThrough/);
    });

    test("construction throws when anchorStream names an unknown stream", () => {
      expect(
        () =>
          new RenderGate(() => {}, {
            coherenceKey: byEventTimestamp,
            // @ts-expect-error — StreamId narrowing catches this at compile time;
            // the runtime check is a safety net for untyped call sites.
            anchorStream: "nonexistent",
            streams: {
              prices: { passThrough: true },
              positions: { passThrough: false, freshness: "match" },
              greeks: { passThrough: false, freshness: "monotonic" },
            },
          }),
      ).toThrow(/not a declared stream/);
    });
  });
});
