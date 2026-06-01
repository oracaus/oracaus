// Demo-loop bench — measures the in-process equivalent of one tick of
// the demo's worker workload: `feed.step()` (synthetic surface generation)
// + `fitSviSlice` over every slice in the resulting surface. Includes the
// per-tick feed-generation overhead that the standalone `svi.bench.ts`
// pre-builds and excludes. Cannot easily exercise a real Worker from
// vitest bench without browser or worker-threads scaffolding; this is the
// CPU-bound work that would otherwise happen inside the worker.
//
// **Note (2026-05-25):** the feed API became multi-slice when the surface-
// fit pipeline replaced the single-slice fitter. The bench was previously
// calling `fitSviSlice(tick.slice)` where `tick.slice` (singular) no longer
// exists — produced `NaNx faster` in the summary because both benches
// errored. Fixed to iterate over `tick.slices`. The per-slice fit covered
// here is the per-tick fit portion of the worker's workload; the worker
// additionally runs `repairCalendarArb` (covered by svi.bench.ts's repair
// scenario), which this loop bench does not include.

import { bench, describe } from "vitest";

import { SyntheticFeed } from "../src/feed.js";
import { fitSviSlice } from "../src/svi/fitter.js";

// Surface size pinned to 50 expiries to match the app's runtime default
// (`DEFAULT_N_EXPIRIES_FITTED` in `App.tsx`). Without this, `SyntheticFeed`
// falls back to its own internal default (70 at time of writing — defined
// in `feed.ts`) which doesn't match the surface a viewer sees on first
// load.
const N_EXPIRIES = 50;

describe("demo loop — feed.step + fit (no worker)", () => {
  const feedFast = new SyntheticFeed({ seed: 42, nExpiriesFitted: N_EXPIRIES });
  bench("feed.step + fit (no inflation)", () => {
    const tick = feedFast.step();
    for (const slice of tick.slices) {
      fitSviSlice(slice);
    }
  });

  const feedShock = new SyntheticFeed({
    seed: 42,
    nExpiriesFitted: N_EXPIRIES,
    shockMultiplier: 5,
  });
  bench("feed.step + fit (under shock)", () => {
    const tick = feedShock.step();
    for (const slice of tick.slices) {
      fitSviSlice(slice);
    }
  });
});
