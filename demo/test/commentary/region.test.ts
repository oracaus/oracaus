// Tests for the region debouncer (Stage 11.2).
//
// The settler is pure (closure-stateful, no React). Tests drive it with
// explicit `update(hoveredRegion, nowMs)` calls and inspect the returned
// `{committed, pending, exiting}` view. No fake timers needed.

import { describe, expect, it } from "vitest";

import {
  createRegionSettler,
  REGION_DWELL_MS,
  REGION_EXIT_GRACE_MS,
  REGION_IDS,
  type RegionId,
} from "../../src/commentary/region.js";

describe("REGION_IDS", () => {
  it("exports the five region literals expected by 11.1", () => {
    expect(REGION_IDS).toEqual([
      "toolbar",
      "naive-panel",
      "gated-panel",
      "chain-table",
      "mismark-sparkline",
    ]);
  });
});

describe("createRegionSettler — initial state", () => {
  it("starts with no committed, pending, or exiting", () => {
    const s = createRegionSettler();
    const out = s.update(null, 0);
    expect(out).toEqual({ committed: null, pending: null, exiting: false });
  });

  it("hovering a region but not dwelling long enough does not commit", () => {
    const s = createRegionSettler();
    expect(s.update("naive-panel", 0)).toEqual({
      committed: null,
      pending: "naive-panel",
      exiting: false,
    });
    // Still under the 1.5 s threshold.
    expect(s.update("naive-panel", REGION_DWELL_MS - 1)).toEqual({
      committed: null,
      pending: "naive-panel",
      exiting: false,
    });
  });
});

describe("createRegionSettler — dwell promotion", () => {
  it("commits exactly at REGION_DWELL_MS elapsed", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 0);
    const out = s.update("naive-panel", REGION_DWELL_MS);
    expect(out).toEqual({
      committed: "naive-panel",
      pending: null,
      exiting: false,
    });
  });

  it("commits with continuous same-region hover across multiple updates (no shared-budget restart)", () => {
    const s = createRegionSettler();
    // Multiple updates with the same region don't restart the dwell timer.
    s.update("naive-panel", 0);
    s.update("naive-panel", 200);
    s.update("naive-panel", 800);
    s.update("naive-panel", 1_200);
    const out = s.update("naive-panel", REGION_DWELL_MS);
    expect(out.committed).toBe("naive-panel");
  });

  it("starting hover at non-zero nowMs anchors the dwell from that moment", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 5_000);
    // 1.5 s after the hover start — should commit.
    const out = s.update("naive-panel", 5_000 + REGION_DWELL_MS);
    expect(out.committed).toBe("naive-panel");
  });
});

describe("createRegionSettler — region switching", () => {
  it("enter(B) while pending A starts a fresh dwell for B (no shared budget)", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 0);
    // Switch to gated mid-dwell.
    s.update("gated-panel", 1_000);
    expect(s.update("gated-panel", 1_000 + REGION_DWELL_MS - 1).committed).toBe(
      null,
    );
    expect(s.update("gated-panel", 1_000 + REGION_DWELL_MS).committed).toBe(
      "gated-panel",
    );
  });

  it("enter(B) from committed A keeps A committed during B's dwell", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 0);
    s.update("naive-panel", REGION_DWELL_MS); // commit naive-panel at t=1500
    // Pointer moves to gated at t=1600.
    const bStart = REGION_DWELL_MS + 100;
    expect(s.update("gated-panel", bStart)).toEqual({
      committed: "naive-panel",
      pending: "gated-panel",
      exiting: false,
    });
    // Halfway through B's dwell — naive-panel still committed.
    expect(
      s.update("gated-panel", bStart + REGION_DWELL_MS / 2).committed,
    ).toBe("naive-panel");
    // After B's full dwell (1.5 s from bStart), commit changes to gated.
    expect(s.update("gated-panel", bStart + REGION_DWELL_MS).committed).toBe(
      "gated-panel",
    );
  });

  it("enter(C) while pending(B) from committed A replaces pending with C (B abandoned)", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 0);
    s.update("naive-panel", REGION_DWELL_MS); // commit naive
    s.update("gated-panel", REGION_DWELL_MS + 100); // pending B
    s.update("chain-table", REGION_DWELL_MS + 500); // C replaces B
    // After 1.5 s of dwelling on C (counted from when C started):
    const cCommittedAt = REGION_DWELL_MS + 500 + REGION_DWELL_MS;
    expect(s.update("chain-table", cCommittedAt).committed).toBe("chain-table");
  });
});

describe("createRegionSettler — exit grace", () => {
  it("leaving committed region starts exit timer; commit holds during grace", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 0);
    s.update("naive-panel", REGION_DWELL_MS); // commit
    expect(s.update(null, REGION_DWELL_MS + 100)).toEqual({
      committed: "naive-panel",
      pending: null,
      exiting: true,
    });
    expect(
      s.update(null, REGION_DWELL_MS + REGION_EXIT_GRACE_MS - 1).committed,
    ).toBe("naive-panel");
  });

  it("uncommits exactly at REGION_EXIT_GRACE_MS elapsed", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 0);
    s.update("naive-panel", REGION_DWELL_MS);
    s.update(null, REGION_DWELL_MS + 100); // start exit timer
    const out = s.update(null, REGION_DWELL_MS + 100 + REGION_EXIT_GRACE_MS);
    expect(out).toEqual({ committed: null, pending: null, exiting: false });
  });

  it("re-entering the committed region within exit grace preserves the commit", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 0);
    s.update("naive-panel", REGION_DWELL_MS);
    s.update(null, REGION_DWELL_MS + 100); // exit timer starts
    // Pointer drops out briefly, returns to naive within grace.
    expect(s.update("naive-panel", REGION_DWELL_MS + 300).committed).toBe(
      "naive-panel",
    );
    // Long past where exit timer would have fired — naive still committed.
    expect(
      s.update(
        "naive-panel",
        REGION_DWELL_MS + 300 + REGION_EXIT_GRACE_MS + 100,
      ).committed,
    ).toBe("naive-panel");
  });

  it("entering a different region from exiting state starts pending for that region", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 0);
    s.update("naive-panel", REGION_DWELL_MS); // commit naive
    s.update(null, REGION_DWELL_MS + 100); // start exit
    // User enters gated before exit grace elapses.
    const out = s.update("gated-panel", REGION_DWELL_MS + 200);
    expect(out.committed).toBe("naive-panel");
    expect(out.pending).toBe("gated-panel");
    expect(out.exiting).toBe(false); // exit was cancelled by hover
  });

  it("no-hover with no committed region returns clean state (nothing to grace)", () => {
    const s = createRegionSettler();
    expect(s.update(null, 0)).toEqual({
      committed: null,
      pending: null,
      exiting: false,
    });
    expect(s.update(null, 10_000)).toEqual({
      committed: null,
      pending: null,
      exiting: false,
    });
  });
});

describe("createRegionSettler — backward-clock defence", () => {
  it("does not decrement the dwell timer when nowMs regresses", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 1_000);
    // Clock regresses below pending.sinceMs — must not commit.
    expect(s.update("naive-panel", 500).committed).toBe(null);
    expect(s.update("naive-panel", 0).committed).toBe(null);
    // Forward time again, must still respect the original sinceMs.
    expect(s.update("naive-panel", 1_000 + REGION_DWELL_MS - 1).committed).toBe(
      null,
    );
    expect(s.update("naive-panel", 1_000 + REGION_DWELL_MS).committed).toBe(
      "naive-panel",
    );
  });

  it("does not decrement the exit timer when nowMs regresses", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 0);
    s.update("naive-panel", REGION_DWELL_MS); // commit
    s.update(null, 2_000); // start exit
    expect(s.update(null, 1_500).committed).toBe("naive-panel"); // backward
    expect(s.update(null, 2_000 + REGION_EXIT_GRACE_MS).committed).toBe(null);
  });
});

describe("createRegionSettler — reset()", () => {
  it("clears committed, pending, and exiting", () => {
    const s = createRegionSettler();
    s.update("naive-panel", 0);
    s.update("naive-panel", REGION_DWELL_MS); // commit
    s.update(null, REGION_DWELL_MS + 100); // start exit
    expect(s.reset()).toEqual({
      committed: null,
      pending: null,
      exiting: false,
    });
    // Post-reset behaviour: fresh dwell required, no leftover state.
    expect(s.update("naive-panel", REGION_DWELL_MS + 100).committed).toBe(null);
  });

  it("is idempotent — reset twice gives the same clean state", () => {
    const s = createRegionSettler();
    s.update("naive-panel", REGION_DWELL_MS);
    s.update("naive-panel", REGION_DWELL_MS);
    s.reset();
    expect(s.reset()).toEqual({
      committed: null,
      pending: null,
      exiting: false,
    });
  });
});

describe("createRegionSettler — exhaustive RegionId coverage", () => {
  it("commits each region after dwell", () => {
    for (const region of REGION_IDS) {
      const s = createRegionSettler();
      s.update(region, 0);
      expect(s.update(region, REGION_DWELL_MS).committed).toBe(region);
    }
  });
});

describe("createRegionSettler — randomised sequences (smoke)", () => {
  it("never throws on arbitrary hover sequences", () => {
    const s = createRegionSettler();
    const seq: Array<RegionId | null> = [
      "naive-panel",
      "gated-panel",
      null,
      "naive-panel",
      "toolbar",
      null,
      null,
      "chain-table",
      "mismark-sparkline",
      "naive-panel",
    ];
    let now = 0;
    for (const r of seq) {
      now += 200;
      expect(() => s.update(r, now)).not.toThrow();
    }
  });
});
