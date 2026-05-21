// Phase 3 demo-loop bench — measures the full feed → worker → fit → return
// round-trip latency. Distinct from the Phase 2 fitter bench (`svi.bench.ts`)
// which measures `fitSviSlice` in isolation; this bench includes the
// generative-feed step + structuredClone serialisation cost (significant
// at 200+ ticks/sec with 21 strikes + true-params bundled into output).
//
// Cannot easily exercise a real Worker from vitest bench without browser
// or worker-threads scaffolding; instead we measure the in-process
// equivalent (feed.step + fitSviSlice on the main thread) which is the
// CPU-bound work that would otherwise happen in the worker. The browser-
// side end-to-end measurement is the in-app accuracy badge under live
// streaming + the manual 60-min stress test in the validation gate.

import { bench, describe } from "vitest";

import { SyntheticFeed } from "../src/feed.js";
import { fitSviSlice } from "../src/svi/fitter.js";

describe("Phase 3 demo loop — feed.step + fit (no worker)", () => {
  const feedFast = new SyntheticFeed({ seed: 42 });
  bench("feed.step + fit (no inflation)", () => {
    const tick = feedFast.step();
    fitSviSlice(tick.slice);
  });

  const feedShock = new SyntheticFeed({ seed: 42, shockMultiplier: 5 });
  bench("feed.step + fit (under shock)", () => {
    const tick = feedShock.step();
    fitSviSlice(tick.slice);
  });
});
