# Demo playbook

Operating instructions for the Oracaus demo. Read once to internalise the
mental model, then keep open as a reference while running scenarios.

---

## TL;DR — the one thing the demo proves

The library's strategy holds visible state during in-flight compute and
commits `(input, output)` atomically. Without it, even with the SAME worker
running the SAME fit, the curve you render and the dots you render can be
from different snapshots — they desynchronise under streaming load. With
it, they can't.

Two panels stacked top (NAIVE) and bottom (ORACAUS) demonstrate this. NAIVE
wires the worker the obvious way (post on every input, accept every
result, render whatever's in state). ORACAUS uses `useCoherentDerivation`.
Same fit; different synchronisation. (Variable names, mode keys, and hook
identifiers retain `gated*` — they name the mechanism, not the panel.)

## When does this library actually matter?

**Honest answer: only when `compute_time / input_interval ≥ ~1`.**
Below that ratio, the worker's idle, the queue can't accumulate, and
both panels render identical state. The library is a no-op — and that's
correct behaviour, not a bug.

The library is load-bearing when **any** of these is true in your
production code:

| Condition                          | Realistic example                                                        |
| ---------------------------------- | ------------------------------------------------------------------------ |
| Heavy compute per event (≥ 16 ms)  | Multi-slice surface fit + Greeks + no-arb checks ≈ 30–50 ms              |
| Compound compute pipeline          | Chain → SVI → P&L → risk metrics chained, totalling 50–100 ms            |
| Multi-instrument scatter-gather    | 100 instruments × 1 ms each = 100 ms per chain tick                      |
| Monte Carlo / scenario revaluation | 100 scenarios × pricing = 50 ms–1 s                                      |
| ML inference in the loop           | Even small models: 20–200 ms forward pass                                |
| User-driven high-frequency input   | Slider drag at 60 Hz emits inputs every ~16 ms; even a 5 ms compute lags |
| Slow client                        | 1 ms on M-series Mac → 50 ms on a budget Android — same code             |

For a single-slice SVI fitter on a beefy machine at typical chain-update
rates, the library is largely invisible. For real options-tech UIs doing
surface fit + Greeks + scenarios + slider responsiveness, it's
load-bearing. **The demo's expiry-count selector is the production-
meaningful way to scale compute** (bench p99 warm at 200 strikes per
slice on M-series Mac, `npm run bench`): 12 expiries fits in ~15 ms;
30 lands at ~36 ms; 50 (the default) at ~58 ms — inside the Form 2 zone
(at its lower edge) and matching SPX-style surfaces' typical 30–60
expiry count; 70 lands at ~82 ms; 80 at ~92 ms. Each step's tooltip
shows the bench-derived p99 — no artificial busy-loops, no synthetic
slowdown, just real surface scaling.

## Are the demo's tick rates realistic?

For a single instrument's chain — **the high end is aggressive.** Real
cadences:

- Per-strike NBBO updates during active trading: 5–50 Hz per strike
- Aggregated chain "refresh trigger" events: 1–20 Hz typically; 50 Hz
  on a fast-moving day
- Vol-surface refit cadence (the thing actually downstream): 1–10 Hz on
  most desks (most refit on spot moves, not every quote)

The demo's 50/100/200/500 Hz selectors over-represent the high end.
500 Hz is unrealistic for chain updates on any single underlying. They're
better read as **proxies for tighter compute-vs-interval ratios** —
the same dynamics that emerge at 50 Hz with a 30 ms compute also emerge
at 500 Hz with a 3 ms compute. The Hz number is a knob into the same
underlying ratio.

---

## Mental model

### The problem

You have a streaming feed (option chain) and a heavy compute (SVI fit).
Per tick:

1. New chain arrives → stored in React state (`latestInputs`).
2. Post compute to worker.
3. Worker fits asynchronously (~10–80 ms in the demo).
4. Result arrives → stored in React state (`data`).
5. React renders: `<Smile dots={latestInputs.slice} curve={data.fitResult.params} />`.

The bug is structural. `latestInputs` updates immediately on tick. `data`
updates whenever a fit lands. They are **independent state slots** — React
will render any combination of `(input_N, output_M)`. When `output_M` was
computed against `input_M` and `M ≠ N`, the displayed `(curve, dots)` pair
is internally inconsistent. The curve is from an input the user has
already moved past.

This is not a worker problem. It's not a strategy-of-coalescing problem.
It's a snapshot-pairing problem.

### The fix

`useCoherentDerivation` with the chain wired as `streaming`:

- Holds `(visible_input, visible_output)` as a SINGLE atomic state slot.
- While compute is in flight, visible state stays put.
- Newer streaming inputs that arrive during compute conflate: only the
  LATEST is remembered as "next to compute".
- When the in-flight compute lands, the substrate commits `(its input,
  its output)` together, and immediately starts compute on the conflated
  pending input (if any).

Net effect: the rendered `(curve, dots)` pair is always from the same
snapshot. Snapshot may be slightly stale (compute takes time), but it's
internally consistent. No inputs-from-now paired with output-from-then.

### Two input kinds — streaming and intent

Real UIs mix two kinds of inputs: streaming (upstream-driven; chain
ticks, position updates) and intent (user-driven; slider drags, mode
toggles, parameter tweaks). The substrate handles both via the same
hook:

- **Streaming inputs** (`options.streaming`): changes **absorb** —
  in-flight completes against its tagged snapshot, then the next
  compute kicks off against whichever streaming value is current at
  completion. Behaviour described in "The fix" above.
- **Intent inputs** (`options.intent`): changes **cancel-and-restart**
  — the in-flight worker is aborted, a fresh compute starts against
  the new (streaming, intent) pair. Visible state holds the previous
  coherent tuple until the restarted compute lands.

The demo wires both kinds simultaneously: the chain ticks are the
streaming input; the **arb-repair toggle in the toolbar** is the
intent input. Scenario 2 demonstrates the cancel-and-restart
behaviour explicitly. The same hook, the same panel — no per-kind
ceremony at the call site.

---

## UI anatomy

```
 Brand bar — Oracaus title · GitHub · npm · LinkedIn
─────────────────────────────────────────────────────────────────────────────
 Toolbar      TICK / SPOT / SEED   TICK RATE [50] [100] [200] [500]
                                   EXPIRIES  [12] [30] [50] [70] [80]
                                   ARB-REPAIR [on] [off]   (intent input)
                                   SLICE     [1M] [3M] [6M] [1Y] [2Y]
                                   SHOCK     [⚡]   (amber while active, 10 s)
─────────────────────────────────────────────────────────────────────────────
 NAIVE                                  │  OPTION CHAIN — Σ|fit − obs|
 ┌─ smile chart ────────┐               │  ┌─ hero ───────────────────┐
 │ ─── solid blue       │               │  │  NAIVE 5.21%   ORACAUS 0.18%│
 │   = fitted SVI curve │               │  │  ratio bar  naive = 28× Oracaus
 │ ⚪ white dots        │               │  └──────────────────────────┘
 │   = observed quotes  │               │  per-strike rows (200 strikes)
 │ 🔴 red dots          │               │   k        naive    Oracaus
 │   = fit disagrees    │               │   −0.20  +0.42%   −0.01%
 │     with truth at    │               │   −0.15  +0.31%   +0.02%
 │     this strike      │               │   ...
 │     (NAIVE only)     │               │
 │ │ dashed cursor      │               │
 │   (red = NAIVE tone) │               │
 │ ┌── overlay ───┐     │               │
 │ │ k       +0.05│     │               │
 │ │ IV fit  18.4%│     │               │
 │ │ IV obs  18.6%│     │               │
 │ │ miss   −0.20%│     │               │
 │ │ g(k)   +0.12 │     │               │
 │ └──────────────┘     │               │
 └──────────────────────┘               │
   ▲ status chips: fitting / coherent / arb-status
   ▼ metric ribbon: lag / compute / mismark / queue
─────────────────────────────────────────────────────────────────────────────
 ORACAUS                                │
 ┌─ smile chart (same shape) ─────┐     │  MismarkSparkline (last 60s)
 │   (no red dots — by design)    │     │  ─── naive trace · ─── Oracaus trace
 │   dashed cursor (green = OK)   │     │
 │   overlay (coherent: miss ≈ 0) │     │
 └────────────────────────────────┘     │
```

### Curves and dots

- **Solid blue curve** — the panel's fitted SVI surface, from `data.fitResult.params`.
- **White dots** — observed quotes (true IV at strike `k_i` + Gaussian noise).
- **Red dots (NAIVE only)** — strikes where the panel's curve disagrees
  with the panel's true SVI params at that strike beyond the noise floor.
  The true params are carried internally per snapshot (`latestInputs.trueParams`
  for NAIVE, `data.sourceTrueParams` for ORACAUS) and used for the diagnostic;
  they're not drawn as a curve. Red dots only light up when the curve is from
  a different snapshot than the dots — i.e. the visible failure mode.

### Cross-view hover overlay

Hover either smile (or any row in the option chain) and a dashed vertical
cursor appears on **both** smile panels at the same `k` — red on the NAIVE
panel, green on the ORACAUS panel (matching the panel chip-rail accents).
The matching chain row highlights. A five-line overlay pins to the
top-left of each smile:

| Line     | What                                                                 |
| -------- | -------------------------------------------------------------------- |
| `k`      | hovered log-moneyness                                                |
| `IV fit` | `√(w(k, fittedParams) / T)` at the panel's fit                       |
| `IV obs` | nearest quote's IV within ±0.02 in k (`—` if no quote near k)        |
| `miss`   | `IV fit − IV obs` — red when \|miss\| > 0.5%                         |
| `g(k)`   | Gatheral butterfly indicator — red when negative (arb violation)     |

**Read for the failure mode at a point.** Under shock, hover at a strike
that has moved. ORACAUS's overlay sits at LM-residual scale (≤ 0.2%). NAIVE's
`miss` blows up — the `IV fit` is from the lagging fit (snapshot N−k); the
`IV obs` is from the freshest quote (snapshot N). The visible (dots, curve)
tear, expressed as one number at a chosen k.

Hovering a chain row demonstrates the third coherence axis: the row's
observed IV equals the smile dot at the corresponding k (both from the
same slice in either panel). In NAIVE the row IV is fresh while the smile
curve is stale; the cursor line, the highlighted dot, and the overlay
together show all three at once.

### Status chips

The chip rail in each panel header shows three chips, left to right:

- **FITTING / IDLE / RESTART** — is there a pending compute? FITTING fires
  when `pendingCount > 0` (NAIVE) or `isComputing` (ORACAUS); RESTART flashes
  on the ORACAUS panel's chip when an intent input change cancels and restarts
  the in-flight compute (arb-repair toggle, expiry change) — briefly amber
  before reverting to FITTING / IDLE. IDLE in steady state.
- **COHERENT / STALE** — **mismark-driven, same logic for both modes**.
  Threshold-gated on `mismark` against the panel's true params (enter
  STALE at 0.005, return to COHERENT at 0.0015 in absolute total-variance
  units). The chip annotates the *visible* dots-vs-curve tear: when the
  chart looks clean, the chip says COHERENT; when red dots appear or
  the curve visibly diverges from the dots, the chip says STALE.
  ORACAUS stays COHERENT unless the fitter itself regresses (mismark on
  ORACAUS is the LM residual against its own snapshot — near-zero in
  normal operation). NAIVE flips to STALE during the visible failure
  mode (heavy load, vol shock, or 2σ+ OU realisations at light load).
  The chip and the bottom-ribbon `mismark` metric move together;
  both reflect what the viewer sees on the smile. (The `lag` metric
  number has its own red/green tone — different signal, see "The four
  metrics" below.)
- **ARB-FREE / REPAIRED / ARB-VIOL** — surface-level calendar-arb status
  from the worker's check / repair pipeline. Four states:
  - `arb-free` (muted): checked, no violations.
  - `repaired` (blue): violations found, repair pass cleared them.
  - `arb-viol` (red): repair attempted, residual violations remain.
  - `arb-viol` (amber): `repairMode = "off"` AND violations detected by
    the check-only pass. User-elected risk — the chip is honest that
    skipping repair produced a non-arb-free surface. Distinct from the
    red `arb-viol` by colour: red means "we tried and failed", amber
    means "we didn't try because you turned repair off".
  Useful to glance at during shock — violations are more likely when
  params drift fast.

### The four metrics — read these carefully

The metric ribbon under each smile shows four numbers. Read them as
diagnostic dials, not summary stats.

| Metric    | What it measures                                                                                                                                                                                                | Library fixes?           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `lag`     | Per-mode tick gap. NAIVE: `abs(latestInputs − data)` — absolute structural skew between displayed dots and displayed curve. ORACAUS: `max(0, currentTickIndex − data)` — staleness of the coherent snapshot.    | **YES**                  |
| `compute` | Wall-clock per surface fit in ms (worker-measured, includes calendar-arb repair pass). Tone-coded against Form 2 zone [50, 150] ms.                                                                             | Just instrumentation     |
| `mismark` | `mean_k \|w(k, fit) − w(k, panel_truth)\|` — curve vs truth at rendered strikes. The visceral tearing measure. Drives the COHERENT/STALE chip directly.                                                         | **YES**                  |
| `queue`   | Pending compute backlog (NAIVE only — ORACAUS conflates). Capped at 20 (`MAX_PENDING_QUEUE`); production naive systems drop or block.                                                                           | **YES** (ORACAUS has none) |

`mismark` and `lag` go red on naive when the failure mode fires.
The two formulas use a `switch` + `assertNever(mode)` helper in
`demo/src/metrics.ts:computeSnapshotLag` so both panels and the
commentary's event detector share a single source of truth — adding
a future panel mode would type-error rather than silently fall
through. `compute` sits in the [50, 150] ms green band at production
scale (50 × 200) on M-series Macs — that's the documented Form 2
zone (CLAUDE.md §The boundary heuristic). `queue` is naive-only.

Top-of-chain hero card additionally shows `Σ|fit − obs|` per panel (the
sum of |miss| over all 200 strikes) and a ratio bar — useful for the
visceral "naive = Nx ORACAUS" headline.

---

## Scenarios — run these in order

Two axes of escalation are interleaved:

- **Load axis** (Scenarios 0 → 1 → 3 → 4 → 5): the compute-to-interval
  ratio climbs, the failure mode gets louder. This is the canonical
  arc — start invisible, end pathological.
- **Input-kind axis** (Scenario 2): same load as Scenario 1, but
  demonstrates the substrate's **intent input** handling via the
  arb-repair toggle. Different aspect of the same primitive.

Run them in numerical order for a coherent demo. Scenario 2 sits next
to Scenario 1 because the settings are identical apart from the toggle
interaction — easy to demonstrate back-to-back. After each, note the
difference between panels in the metrics block. The narration column
tells the story for an audience.

### Scenario 0 — baseline (the failure mode at its smallest, but already present)

| Setting    | Value                                                      |
| ---------- | ---------------------------------------------------------- |
| Tick rate  | 50/s                                                       |
| Expiries   | 12 (lightest available — ~15 ms p99 per bench)             |
| Arb-repair | off (no repair pass)                                       |
| Slice      | 1Y (default)                                               |
| Vol shock  | off                                                        |

**Expected:** the panels look identical to the eye at this scale, but
the hero card and ribbon show the gap structurally:

- `compute` reads in the low-to-mid teens (bench p99 ~15 ms at 12 × 200);
  at 50 Hz the 20 ms tick interval comfortably exceeds compute, so `queue`
  on naive stays at 0 in steady state.
- **ORACAUS mismark sits at noise-floor / LM-residual scale (~5e-5).**
  COHERENT chip, no red dots.
- **NAIVE mismark mostly small (~1e-3, well below the 5e-3 STALE
  threshold), occasional spikes during 2σ+ realisations of the
  underlying OU walk on the level parameter `a`.** When spikes happen
  the chart paints red dots uniformly (the `a` drift shifts the whole
  fitted curve up or down relative to the displayed truth).
- **NAIVE `lag` chip fluctuates 1–9 ticks** — structural staleness
  between the 5 Hz throttled input view and the eagerly-set fit. The
  lag *number* stays green (tone threshold is 10) because the
  fluctuation is normal at this scale; the chip would only turn red
  when lag clearly exceeds the display-throttle envelope (Scenario 1+).
- **NAIVE chip COHERENT most of the time, occasional STALE during
  the mismark spikes.** Mismark-driven only; the chip annotates what
  the chart shows. No flicker when the chart looks clean.
- **Hero card Σ|miss| shows ~15–25% ORACAUS vs ~100–300% naive —
  roughly 5–25× ratio** depending on the moment's OU realisation. Even
  at this lightest setting the structural gap is measurable.

**Why the library is already working at this setting.** Independent of
how full the queue gets, the display throttle keeps the displayed input
view 1–9 ticks behind real time while `setData` fires eagerly on worker
completion. The naive panel renders `latestInputs` (slightly stale)
paired with `data` (fresh) — they're from different ticks.
Most of the time the OU drift across those ticks is small enough that
mismark stays at the noise floor; occasionally the drift produces a
visible all-red moment. ORACAUS's commit carries its own `sourceSlice`
so the displayed pair is always from the same tick — mismark stays at
LM residual regardless.

**Narration:** _"This is the demo at its lightest — 12 expiries, 50 Hz,
no shock. The panels look identical to the eye most of the time. But
watch the lag chip on naive — it fluctuates 1–9 ticks. That's the
structural skew the library prevents. The hero card has the numbers:
naive sits at a few percent, ORACAUS at a fraction of a percent. Every
few seconds an OU realisation pushes naive's mismark past the noise
floor and the chart goes all-red for a moment — that's a snapshot
where the input view and the fit happened to drift far apart. ORACAUS
never shows that because its (input, output) pair always comes from
the same tick. This is the quietest version of the failure mode, and
even here it's measurable. The visceral version comes when you scale
the compute up."_

---

### Scenario 1 — production-realistic full surface (canonical demo)

| Setting    | Value                                                      |
| ---------- | ---------------------------------------------------------- |
| Tick rate  | 50/s                                                       |
| Expiries   | 50 (default — 200 strikes × 50 expiries = SPX-realistic) |
| Arb-repair | on (default — production-realistic pipeline)               |
| Slice      | 1Y                                                         |
| Vol shock  | off                                                        |

**Expected:** within ~3 seconds the naive panel diverges:

- `queue` climbs to and stays capped at 20 (`MAX_PENDING_QUEUE`)
  within a fraction of a second
- `lag` grows to ~40–50 ticks (~0.8–1.0 s of structural skew —
  queue saturation + the 5 Hz throttle staleness)
- `mismark` crosses 0.005 → STALE chip (mismark-driven; chart visibly
  tears)
- `compute` reads in the [50, 150] ms Form 2 zone (bench p99 warm
  for 50 × 200 is ~58 ms; the demo's runtime metric is read off
  individual ticks and will fluctuate around it)
- Many dots paint red on the smile under shock; even at quiescent
  steady-state several wing strikes light up
- Hero card: NAIVE Σ|miss| 5×–30× ORACAUS

ORACAUS stays at:

- `lag` ≤ 1 tick (compute time only; substrate's coherent snapshot
  vs feed's latest)
- `mismark` at LM-residual / noise floor (~5e-5 — orders of magnitude
  below STALE threshold)
- COHERENT, no queue, no red dots
- Hero card: ORACAUS holds at LM-residual scale

**Narration:** _"This is the realistic case for a vol-surface UI: full
surface (50 expiries × 200 strikes) refit including calendar-arb repair
lands at the lower edge of the Form 2 zone (~58 ms p99 per bench), chain
ticks at 50 Hz. Compute is roughly 3× the tick interval. Naive's
queue grows; the fits that land come from older and older inputs while
the dots on the chart keep updating. Watch the lag column — naive at
40–45 ticks (queue saturates at 20 + structural drift + throttle
staleness), ORACAUS at 0. Same worker, same fit; only the
synchronisation strategy differs."_

This is the canonical demo. The default settings on first page load.

---

### Scenario 2 — intent input (cancel-and-restart on toggle)

| Setting    | Value                                                      |
| ---------- | ---------------------------------------------------------- |
| Tick rate  | 50/s                                                       |
| Expiries   | 50 (default — same as Scenario 1)                          |
| Arb-repair | toggle off → on → off (during demo)                        |
| Slice      | 1Y                                                         |
| Vol shock  | off                                                        |

The arb-repair toggle is wired as an **intent input** to
`useCoherentDerivation`. Changing it cancels any in-flight compute on the
ORACAUS panel and restarts against the new mode. The naive panel has no cancel
semantics — its in-flight completes against the old mode before
subsequent ticks pick up the new mode.

**Expected on toggle:**

- **ORACAUS:** the `fitting` chip briefly flips to `RESTART` (~58 ms)
  as the cancel-and-restart fires, then reverts to `fitting`. The
  next emit shows the new repair-mode result.
- **NAIVE:** the `fitting` chip stays continuously on (no cancel
  semantics); the in-flight fit lands against the OLD mode first;
  the next tick (after toggle) gets the new mode. Brief lag
  between the toggle click and the visible mode change.
- **Both panels:** during the brief window between toggling repair
  off and the new no-repair fits landing, the arb-status chip can
  flip to amber `arb-viol` if the unrepaired surface carries
  calendar violations. User-elected risk — the chip is honest that
  skipping repair produced a non-arb-free surface.

**Narration:** _"Most UIs mix streaming inputs (the chain) with intent
inputs (user toggles, slider drags, mode selectors). The library handles
both. Streaming changes absorb — in-flight completes against its tagged
snapshot. Intent changes cancel-and-restart — in-flight is aborted, a
fresh compute starts against the newest mode. Watch the ORACAUS panel:
toggling arb-repair fires the `fitting` chip instantly, ORACAUS commits
the new-mode result, no leakage from the old mode. Same panel, both
input kinds, one mechanism."_

---

### Scenario 3 — heavier surface

| Setting    | Value                                                      |
| ---------- | ---------------------------------------------------------- |
| Tick rate  | 100/s                                                      |
| Expiries   | 80 (heaviest selector)                                     |
| Arb-repair | on                                                         |
| Slice      | 3M or 6M (try different tenors)                            |
| Vol shock  | off                                                        |

**Expected:** larger surface + tighter tick interval = bigger compute-
to-interval ratio. Naive falls badly behind:

- `queue` saturates at 20 within a fraction of a second
- `lag` grows large at 100 Hz × 80 expiries (compute > 9× the tick
  interval; queue saturates fast; read the running metric for the
  empirical lag value)
- Multiple red dots; chip mostly STALE, flips to COHERENT
  occasionally when mismark happens to dip
- `compute` reads in the [85, 100] ms range (bench p99 at 80 × 200
  ~92 ms detection-only); spikes higher when the repair pass iterates
  on noise-induced calendar violations

ORACAUS stays largely coherent but compute lag becomes visible at this
scale: `lag` can occasionally exceed 10 ticks (~100 ms behind feed)
during the worst compute spikes. The substrate's atomic-commit guarantee
holds — chip stays COHERENT, no red dots — but the displayed coherent
snapshot lags real-time more noticeably than at Scenario 1.

Switching the slice mid-scenario demonstrates the y-axis transition —
the chart smoothly animates between tenor scales on the GPU compositor.

**Narration:** _"As surface scale grows, compute extends. At 80 expiries
× 200 strikes the surface fit takes about 92 ms (bench p99), spiking
higher when repair iterates. With a 10 ms tick interval (100 Hz) naive's
queue saturates at 20 within milliseconds; the displayed dots run ahead
of the curve by a wide margin. Even ORACAUS shows visible lag at this
scale — but it stays coherent: dots and curve always from the same
snapshot, just one that lags real-time. The library's value isn't 'no
lag' — it's 'lag without tearing'."_

---

### Scenario 4 — vol shock (the visceral one)

| Setting    | Value                                                      |
| ---------- | ---------------------------------------------------------- |
| Tick rate  | 50/s                                                       |
| Expiries   | 50 (default)                                               |
| Arb-repair | on                                                         |
| Slice      | 1Y                                                         |
| Vol shock  | **TRIGGER** (the amber lightning button, then watch)       |

**Expected:** during the 10-second shock burst:

- True SVI parameters evolve 5× faster than baseline; the white dots
  visibly migrate across the chart as the surface morphs tick-to-tick
- Naive's solid curve trails behind — the gap between curve and dots
  opens visibly at moved strikes; clusters of red dots light up where
  the lagging fit disagrees with the current truth
- ORACAUS's solid curve tracks the dots one fit behind, no red dots,
  chip stays COHERENT
- `mismark` spikes on naive; ORACAUS unmoved at LM-residual scale
- Hover at a moved strike: NAIVE overlay's `miss` blows up; ORACAUS's
  overlay stays at LM-residual scale
- Arb-status chip may flip to `repaired` (or occasionally `arb-viol`)
  on **both** panels — they run the same fitter against the same
  noise-perturbed observations, so under shock both can see calendar
  violations. The library doesn't protect against arb-status changes;
  it protects (input, output) pair coherence regardless of what the
  fit produces.

After the 10 s the shock ends, params mean-revert, both panels return
to baseline — ORACAUS's `mismark` snaps back to LM-residual scale
immediately on the next emit; naive drains the lag-induced gap as the
queue clears.

**Narration:** _"This is the failure mode at its most visible. When
markets move fast — earnings, news, vol regime change — your synthesis
of streaming inputs has to keep up. Hover a strike that's moved: naive
shows the fit from snapshot N−k and the observation from snapshot N
side by side, the gap is numerical. ORACAUS shows them coherent. Without
alignment, your trader sees a smile that's seconds out of date. With
alignment, they see a smile that's at most one fit late, but always
internally consistent."_

---

### Scenario 5 — break it (pathological)

| Setting    | Value                                                      |
| ---------- | ---------------------------------------------------------- |
| Tick rate  | 500/s                                                      |
| Expiries   | 80                                                         |
| Arb-repair | on                                                         |
| Slice      | 1Y                                                         |
| Vol shock  | TRIGGER                                                    |

**Expected:** naive's queue saturates at 20 (cap) within milliseconds.
`lag` grows to ~300 ticks (the naive panel shows a smile from
several seconds before you triggered the shock).

ORACAUS stays COHERENT but its `lag` chip flickers 0–25 ticks at this
setting — the substrate's atomic-commit guarantee still holds (dots
and curve always from the same snapshot), but the worker can't keep up
with 500 Hz ticks at 80 expiries, so the displayed coherent snapshot
genuinely lags real-time by ~50–500 ms. **This is the demo's most
important Scenario 5 lesson: at pathological scale, ORACAUS still
doesn't tear, but it does become *visibly stale*.** Use it to make
the contrast unmissable — and to surface the library's honest scope:
"render-coherent" is not "real-time".

This is intentionally pathological. Use to make the contrast unmissable.

---

## Recording mode

For reproducible takes (screen recording, blog screenshots), use URL
params:

| Param             | Effect                                                               |
| ----------------- | -------------------------------------------------------------------- |
| `?seed=<int>`     | Locks the synthetic feed PRNG. Same seed → byte-identical evolution. |
| `?mode=recording` | Status flag in the header (so you remember it's locked).             |

Example: `http://localhost:5173/?seed=42&mode=recording` — every reload
produces the exact same tick stream. The advanced-controls dialog also
exposes the seed so you can fork without reloading.

For the canonical published recording (60–90s, captions only): open with
seed at default settings (50 expiries × 200 strikes, arb-repair on, 1Y
slice, 50 Hz), let it run ~5 seconds for steady state, trigger vol shock,
watch through the burst (10 s) — naive tears, ORACAUS holds — then briefly
toggle arb-repair off then on to demonstrate intent-input cancel-and-restart
(the ORACAUS panel's `fitting` chip flashes RESTART on each toggle). The
visceral arc: stable → shocked → ORACAUS-holding-while-naive-tears →
intent-toggle cameo → recovery. This single recording ships on every
surface (root README hero, mini-series piece 4 article body, HN post
footer-links, folder 16's standalone LinkedIn drop). Toggle the in-demo
commentary OFF before recording so the toast stack doesn't compete with
the recording's own captions.

---

## Demo narration — 2-minute version

A presenter's script for showing this live to colleagues. Replace the
panel-pointing with whatever your audience is looking at.

> "Here's a synthetic option chain at 50 ticks per second. Each tick the
> spot moves and the underlying SVI parameters drift by a small amount.
> The same feed goes into two panels.
>
> Both panels run the same SVI fitter in a Web Worker. The fitter is the
> same code. The compute time is the same. The dots are the same observed
> IVs.
>
> The only difference is how each panel SYNCHRONISES the fit result with
> the dots. The top panel (NAIVE) uses the obvious React pattern — the
> dots come from the latest chain, the curve from whatever fit just
> landed; they update independently. The bottom panel (ORACAUS) uses
> `useCoherentDerivation` from the Oracaus library — the (input, output)
> pair commits atomically.
>
> At the default 50 expiries × 200 strikes the surface fit lands at the
> lower edge of the Form 2 zone (~58 ms p99 per bench); ticks arrive
> every 20 ms at 50 Hz. Compute is roughly 3× the tick interval. Watch
> the queue depth on naive — it climbs and caps
> at 20. The lag metric: naive at 40–45 ticks, ORACAUS at 0.
>
> [if starting from a lighter setting, click EXPIRIES → 50 to show the
>  failure mode appearing as the surface scale crosses the boundary]
>
> Look at the smile chart. Naive's red dots — those are strikes where
> the curve says one thing and the underlying truth says another. The
> curve is from an old fit. The dots are from a newer chain. They came
> from different moments in time.
>
> ORACAUS has zero red dots. Whatever's on screen is internally consistent —
> the curve was fitted to the dots that are visible.
>
> [click vol shock]
>
> Now the truth is moving fast. You can see the white dots migrating
> across the chart tick-to-tick as the underlying surface morphs. Watch
> naive's solid curve fail to keep up — the gap between the curve and the
> dots opens visibly, and red dots light up at the strikes that have moved
> most. ORACAUS's solid curve tracks the dots one fit behind, but it
> always fits the dots that are visible.
>
> The library doesn't make the fit faster. It doesn't make the worker
> better. It doesn't even change which fits run. It changes what state
> the React panel HAS at any given moment — always a coherent
> `(input, output)` pair, never a Frankenstein composition."

---

## Troubleshooting

**Both panels look identical and I can't see any difference.**
You're probably in Scenario 0 territory (small expiry count). The
panels look identical at this absolute scale — but check the hero
card: even here naive Σ|miss| typically sits ~25× higher than ORACAUS.
The visible failure mode (red dots, visible curve/dots tear) appears
once compute exceeds the tick interval — bump EXPIRIES to 50 (default)
or 70 / 80, or trigger vol shock.

**Numbers fluctuate a lot between frames.**
Expected. The IV noise (σ_iv = 0.001, 10 bps — SPX-ATM-realistic)
injects fresh noise each tick; the mismark is a sum of noisy
quantities. Watch the trend over a few seconds, not single frames.

**Naive smile suddenly snaps to a totally different shape.**
That's the queued fit-from-several-seconds-ago finally landing. The
drama is the point.

**Shock button stays amber.**
That's the burst window — locked for 10 s by design (you can't
double-trigger). The icon returns to its muted unhighlighted state when
done.

**Y-axis snaps when switching slices.**
Should animate smoothly. The transition runs as a Web Animations API
keyframe on the chart's inner SVG group (compositor-only — visible in
DevTools' Animations panel). If it snaps without animating, check
`prefers-reduced-motion` in your OS settings — we honour that
preference by setting `duration: 0`.

**Arb-repair toggle has no visible effect.**
In calm regimes the calendar-arb repair pass rarely activates (the
chip shows `arb-free`). Toggle the chip rail's `arb-status` indicator —
if it's already `arb-free`, the repair pass had nothing to repair.
Trigger vol shock with arb-repair on; the chip is more likely to flip
to `repaired` during the burst.

**Local dev server is hot-reloading mid-demo and breaking my recording.**
Use the production build for recording: `npm run -w @oracaus/demo build`
then `npm run -w @oracaus/demo preview`. Or set Vite to disable HMR.

**Page loads at `/`.**
That's correct in all modes. The demo serves at the subdomain root
`https://demo.oracaus.dev` in production (custom domain via
`demo/public/CNAME`), and `localhost:5173/` in dev / `localhost:4173/`
in preview. Vite's `base` is `/` everywhere.

---

## What the demo deliberately does NOT show

- **Real-time exchange feed** — synthetic feed only for v1. Documented
  as known limitation; adopters wire their own feed to the input port.
- **Multi-instrument scatter-gather** — single-instrument SVI calibration
  only. Post-v1 if signal demands.
- **Worker pool** — one worker per hook instance. Pooling is post-v1.
- **Sequential derivation chains** — one compute per substrate instance;
  multi-stage async pipelines are out of scope. [Article piece 4](https://www.linkedin.com/pulse/anatomy-substrate-substantive-screen-side-derivation-przemys%C5%82aw-ka%C5%82ka-iklae/)
  ("§The Substrate Isn't") describes the two compositional shapes
  available to consumers (bundle into one compute, or keep downstream
  synchronous).
- **Greeks overlay for a hovered strike** — could be added as a render-
  body synchronous derivation against the substrate-emitted surface;
  intentionally deferred to keep the demo focused.

These exclusions are explicit scope decisions, not gaps in the
implementation. The demo is calibrated to land one point — render
alignment under streaming compute, with the mixed-input case showing
intent inputs slot into the same primitive.
