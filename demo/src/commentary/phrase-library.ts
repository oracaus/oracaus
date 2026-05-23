// Phrase library — pluggable phrase content for the scheduler.
// Single-variant stub; richer multi-variant content is a roadmap item.
// The `pickPhrase(input, context) → PhraseSpec | null` interface is
// locked.
//
// Phrase-id namespace:
//
//   - `scenario-{name}-v{n}` — scenario entries (e.g. `scenario-S4-shock-v1`)
//   - `event-{type}-v{n}`    — detector events (e.g. `event-TearStart-v1`)
//   - `ack-{control}-v{n}`   — settings-change acks (e.g. `ack-expiries-v1`)
//
// Cooldown: returns `null` when the chosen phrase id is within
// `COOLDOWN_PHRASE_ID_MS`; the scheduler drops the input in that case.

import type { CommentaryEvent } from "./events.js";
import type { PhraseSpec } from "./phrase-sequencer.js";
import type { RegionId } from "./region.js";
import type { Scenario } from "./scenarios.js";
import {
  COOLDOWN_PHRASE_ID_MS,
  type PhraseLibrary,
  type PhrasePickContext,
  type SchedulerInput,
  type SettingsAckControl,
} from "./scheduler.js";

/**
 * Tier per scenario. T3 = substrate-vs-naive comparison (the demo's
 * default narration register), T1 = shock (critical), T4 = calm
 * baseline (observation).
 */
export const SCENARIO_ENTRY_TIER: Record<Scenario, 1 | 2 | 3 | 4> = {
  "S0-baseline": 4,
  "S1-canonical": 3,
  "S2-intent-toggle": 3,
  "S3-heavier": 3,
  "S4-shock": 1,
  "S5-pathological": 1,
};

// PLAYBOOK §Scenarios 0–5. Three distinct-angle variants per scenario;
// the scheduler rotates through them via LRU + per-id cooldown.
//
// Tier per scenario follows `SCENARIO_ENTRY_TIER` above (T1 critical /
// T3 comparison / T4 observation). Variants share that tier.
const SCENARIO_ENTRY_VARIANTS: Record<Scenario, readonly string[]> = {
  "S0-baseline": [
    // angle: settings position on the load axis (no behavioural claim)
    "Light surface, moderate ticks. Lightest end of the load axis.",
    // angle: substrate-meta — what parity (if observed) implies
    "When panels match, the substrate is invisible.",
    // angle: instructive — escalate to provoke the failure mode
    "Bump expiries or tick rate for heavier load.",
  ],
  "S1-canonical": [
    // angle: load named + observation pointer (lag is machine-dependent)
    "Production-realistic surface. Watch where naive's lag lands.",
    // angle: Oracaus's outcome named
    "Oracaus stays coherent — dots and curve from one snapshot.",
    // angle: the thesis distilled
    "Same fitter, different commit. Composition timing does the rest.",
  ],
  "S2-intent-toggle": [
    // angle: action — pointer to Oracaus, where the cancel-restart shows
    "Intent input toggled. Oracaus cancels in-flight and restarts.",
    // angle: contrast — Oracaus cancels, naive's tick stream carries on
    "Intent change cancels Oracaus's in-flight; naive's queue carries on.",
    // angle: visible artefact — chip flash
    "Watch Oracaus's fitting chip flash on intent change.",
  ],
  "S3-heavier": [
    // angle: regime + observation pointer (compute claim is machine-dependent)
    "Heavier surface. Watch how naive's lag responds to the load.",
    // angle: mechanism — conditional, holds when the failure shows
    "When naive lags: fits tagged to older snapshots than the dots.",
    // angle: Oracaus's outcome — hedged (commit cadence depends on machine)
    "Oracaus's commit cadence may drop, but each commit stays coherent.",
  ],
  "S4-shock": [
    // angle: speed dimension + observation pointer (specific tick lag is machine-dependent)
    "Shock. Truth moving fast. Watch how far naive's curve falls behind.",
    // angle: visible drift instruction
    "Vol burst. Watch naive's solid curve drift behind the latest dots.",
    // angle: where to look — conditional on tear (machine-dependent visibility)
    "Shock fires. If naive tears, the red dots cluster where strikes moved most.",
  ],
  "S5-pathological": [
    // angle: the pile-up — queue saturated
    "Pathological. Naive's queue saturated, new posts dropping. Oracaus one fit behind.",
    // angle: Oracaus's consistency — never wrong shape
    "Oracaus lands one fit behind truth, but never composes the wrong shape.",
    // angle: the limit case — all knobs at max
    "Maximum pressure. Naive overwhelmed; Oracaus commits less often but matches each pair.",
  ],
};

// PLAYBOOK §Event narration. Three distinct-angle variants per event;
// the scheduler rotates via LRU + per-id cooldown. Tier per event
// matches `CommentaryEvent`'s literal tier; variants share that tier.
const EVENT_VARIANTS: Record<CommentaryEvent["type"], readonly string[]> = {
  ShockStart: [
    // angle: action — what's happening in the underlying
    "Vol shock fired. Sigma at five times normal; truth moving five times faster.",
    // angle: visible — where the failure will show up
    "Shock active. Watch naive's solid curve trail behind the latest chain dots.",
    // angle: where to look — pointer, no assertion that tear will happen
    "Shock active. Watch naive for tearing at the strikes that move fastest.",
  ],
  ShockEnd: [
    // angle: action — state change
    "Shock cleared. Sigma back to baseline; truth slowing down.",
    // angle: trajectory — pointer, no assertion about recovery time
    "Shock over. Watch the naive curve return to alignment.",
    // angle: regime return
    "Vol burst ended. Both panels converging back to the calm regime.",
  ],
  TearStart: [
    // angle: detection — what the metric just saw
    "Tear detected. Many naive strikes showing IV miss past the noise floor.",
    // angle: visual — where to look
    "Naive tearing visibly. Red dots clustering at the strikes that moved most.",
    // angle: mechanism — why it's happening
    "Naive's curve fits an older snapshot; the dots have moved past it.",
  ],
  TearRecovery: [
    // angle: state change — back to coherent
    "Naive recovered. Curve back in line with the latest dots.",
    // angle: metric — mismark dropped
    "Naive's mismark dropping back below the noise floor across the slice.",
    // angle: visual — red dots clearing
    "Red dots clearing. Naive's composition coherent again for now.",
  ],
  QueueSaturated: [
    // angle: pile-up — queue full, posts dropping
    "Naive's queue at twenty — saturated. New posts dropping at the cap.",
    // angle: why — fits slower than ticks
    "Fits landing slower than the feed ticks. Naive's queue full; the rest drop.",
    // angle: real-world parallel
    "Naive hit the twenty pending fits cap. Real systems drop or block; this demo drops.",
  ],
  RepairFailed: [
    // angle: what happened
    "Repair pass exhausted iterations. Surface still carries calendar-arb violations across slices.",
    // angle: consequence — surface-compute output, panel-neutral
    "Repair couldn't clear all calendar-arb violations. The output surface emits with cross-slice arb.",
    // angle: regime — when this happens
    "Repair gave up. Noise-induced violations beyond what the repair pass can clear.",
  ],
  IntentToggle: [
    // angle: action — Oracaus cancels and restarts
    "Repair-mode toggled. Oracaus cancels in-flight, restarts against the new value.",
    // angle: contrast — Oracaus cancel-restarts, naive's queue carries on
    "Intent input changed. Oracaus runs cancel-and-restart; naive's queue carries on.",
    // angle: visual — what to watch
    "Watch Oracaus's fitting chip flash. Cancel-restart on intent change.",
  ],
  ControlChanged: [
    // angle: temporal — both panels apply on next tick (explicit "both")
    "Setting changed. Both panels pick it up next tick.",
    // angle: semantic — Oracaus absorbed not cancelled
    "Streaming change. Oracaus absorbs without cancel.",
    // angle: contrast with intent — Oracaus keeps the in-flight running
    "Value changed. Oracaus keeps the in-flight running.",
  ],
};

// PLAYBOOK §UI anatomy — Toolbar. Settings-ack phrasing for each
// control's discrete value (closed App-side enums: TICK_RATES,
// EXPIRY_COUNTS, DISPLAY_MATURITIES, REPAIR_MODES). Every phrase sits
// inside the 4–7 word range (Stage 10.1 budget). Acks share the T3
// 5 s visibility floor via the id-prefix branch in `computeDismissMs`,
// so the screen time is the same across controls. Unknown values fall
// back to `"{control}: {value}"` inside `ackText`.

const ACK_TICK_HZ_TEXT: Readonly<Record<number, string>> = {
  50: "Tick rate now fifty per second.",
  100: "Tick rate now one hundred per second.",
  200: "Tick rate now two hundred per second.",
  500: "Tick rate now five hundred per second.",
};

const ACK_EXPIRIES_TEXT: Readonly<Record<number, string>> = {
  6: "Surface now spans six expiries.",
  12: "Surface now spans twelve expiries.",
  30: "Surface now spans thirty expiries.",
  50: "Surface now spans fifty expiries.",
  70: "Surface now spans seventy expiries.",
  80: "Surface now spans eighty expiries.",
};

// Keyed by `displayMaturityYears` (the App's stepped slice selector).
// Tolerant to floating-point representation of 1/12 (we use Math.abs
// tolerance in the lookup to match the App's existing `findClosestMaturityIdx`).
const ACK_SLICE_TEXT: ReadonlyArray<{
  readonly years: number;
  readonly text: string;
}> = [
  { years: 1 / 12, text: "Now showing the one-month slice." },
  { years: 0.25, text: "Now showing the three-month slice." },
  { years: 0.5, text: "Now showing the six-month slice." },
  { years: 1, text: "Now showing the one-year slice." },
  { years: 2, text: "Now showing the two-year slice." },
];

/**
 * Resolve a settings-ack input to its templated phrase text. Defensive
 * fallback (`"{control}: {value}"`) covers values that fall outside the
 * closed enums — out of design space but cheap to defend.
 */
function ackText(
  control: SettingsAckControl,
  value: number | "on" | "off",
): string {
  switch (control) {
    case "tickHz": {
      if (typeof value !== "number") return `${control}: ${String(value)}`;
      return ACK_TICK_HZ_TEXT[value] ?? `${control}: ${value}`;
    }
    case "expiries": {
      if (typeof value !== "number") return `${control}: ${String(value)}`;
      return ACK_EXPIRIES_TEXT[value] ?? `${control}: ${value}`;
    }
    case "displayMaturityYears": {
      if (typeof value !== "number") return `${control}: ${String(value)}`;
      // Tolerant lookup — 1/12 in fp has trailing bits.
      const entry = ACK_SLICE_TEXT.find(
        (e) => Math.abs(e.years - value) < 1e-6,
      );
      return entry?.text ?? `${control}: ${value}`;
    }
    case "repairMode": {
      if (value === "on") return "Repair mode on; surface now arb-free.";
      if (value === "off") return "Repair mode off; per-slice raw fits.";
      return `${control}: ${String(value)}`;
    }
  }
}

// PLAYBOOK §The four metrics. Stage 11 prep — pointer-aware metric
// narration consumes these via a future input variant; Stage 10 only
// lands them as exported constants. The `{value}` placeholder is
// substituted at fire time by Stage 11's narration driver, which
// converts the bare numeric to a narrated word ("ten" not "10",
// "seventy-five" not "75"). Templates always use the plural unit
// form — the demo's metric values are always plural at fire time
// (lag fires past 1 tick, compute past 1 ms, mismark in tens of
// basis points, queue past 1 pending fit).
//
// Tier 4 — observation register, no preemption pressure. T4 word
// budget is 5–9 (Stage 10.1); every template fits.
//
// Not yet enqueueable: `SchedulerInput` has no `metric` kind, and
// `variantIdsFor` has no case that produces these ids. Verified by
// a scheduler test in `scheduler.test.ts`.

export type MetricKey = "lag" | "compute" | "mismark" | "queue";

export const METRIC_TEMPLATES: Readonly<Record<MetricKey, string>> = {
  // "Structural skew" — generic across both panel modes. NAIVE's lag
  // is `abs(latestInputs - data)` (both directions matter — data can
  // be either ahead of or behind the input view depending on load
  // regime); Oracaus's is `max(0, currentTickIndex - data)` (staleness
  // of the coherent snapshot). "Behind real-time" was the pre-fix
  // framing and is wrong for NAIVE at light load. See
  // `demo/src/metrics.ts` for the per-mode formula.
  lag: "Lag at {value} ticks of structural skew.",
  compute: "Surface fit landing in {value} milliseconds.",
  mismark: "Curve mismark at {value} basis points across strikes.",
  queue: "Naive's queue at {value} pending fits.",
};

// PLAYBOOK §Demo narration — 2-minute version, final paragraph. The
// closing line for the recording-mode driver (Stage 12). Distilled
// from the four-sentence PLAYBOOK closing ("doesn't make the fit
// faster… changes what state the panel HAS… never a Frankenstein
// composition"); the toast carries the rhetorical shape without the
// paragraph length. Tier 3.
//
// The phrase id `closing-v1` is deliberately NOT reachable through
// any `SchedulerInput` shape — `variantIdsFor` below has no case that
// produces it. The Stage 12 recording driver fires it explicitly via
// the `pushPhrase` path; normal OBSERVATION-tick scheduling cannot
// reach it. Verified by a scheduler test in `scheduler.test.ts`.
export const CLOSING_PHRASE: PhraseSpec = {
  id: "closing-v1",
  text: "Same compute. Oracaus lands a coherent pair, never Frankenstein.",
  tier: 3,
  gapAfterMs: 0,
};

// PLAYBOOK §UI anatomy + §The four metrics + §The fix — pointer-aware
// insight narration (Stage 11). Three variants per region; selected via
// LRU rotation + 60 s per-id cooldown (same mechanism as scenario/event
// variants).
//
// Each phrase passes the five Stage 11.4/11.8 invariants:
//   1. Insight not readout — interprets, doesn't narrate values.
//   2. PLAYBOOK §source — cited per region (block-level) + per-variant
//      angle comment.
//   3. Machine-independent — no compute-time, lag-magnitude, or
//      behavioural-visibility assertion. Uses conditional framings
//      ("when", "above the noise floor", "looks small") where the
//      consequence depends on observed state.
//   4. Panel scope explicit — phrases that name substrate-vs-naive
//      behaviour name the panel.
//   5. Narrative seamlessness — reads cleanly in a quiet S1 moment;
//      polite-enqueue (11.6) drops the input silently during shock /
//      ack chains so the phrase never lands at the wrong moment.
//
// Tier T3 default; phrases are 8–13 words. Word counts noted inline.
// Input-side tier is set at enqueue time (Stage 11.6).
const REGION_INSIGHT_VARIANTS: Record<RegionId, readonly string[]> = {
  // §UI anatomy — Toolbar; §When does the library matter (load axis).
  toolbar: [
    // angle: what the controls demonstrate — position on the load axis
    "These controls move you along the compute-vs-interval ratio.", // 8
    // angle: when the failure mode emerges — ties toolbar settings to compute/interval
    "These settings determine when the failure mode emerges — compute outruns tick interval.", // 12
    // angle: substrate guarantee — invariant across settings
    "Whatever the settings, Oracaus commits coherent pairs; naive may not.", // 10
  ],
  // §The four metrics — lag / mismark; §The fix — composition timing.
  "naive-panel": [
    // angle: lag interpretation — ticks → real time of stale state
    "Each tick of naive's lag is another tick of stale state on screen.", // 13
    // angle: mismark interpretation — divergence vs measurement noise
    "Naive's mismark above the noise floor is real divergence, not fit error.", // 12
    // angle: substrate thesis — names the failure mode at the conceptual level
    "Naive's failure mode is composition timing, not the fit itself.", // 10
  ],
  // §The four metrics — mismark; §Curves and dots; §The fix.
  "gated-panel": [
    // angle: mismark interpretation — LM-residual floor, not a fit-quality score
    "Oracaus's mismark sits at the fitter's noise floor — not a fit-quality indicator.", // 13
    // angle: structural guarantee — red dots can't exist by construction
    "Oracaus never shows red dots — the curve always matches the dots' snapshot.", // 13
    // angle: why — structural vs faster compute
    "Oracaus's coherence is structural — guaranteed by the substrate, not by faster compute.", // 12
  ],
  // §UI anatomy — Hero card; §Option chain — per-strike rows; §The fix.
  "chain-table": [
    // angle: scale — per-row miss looks small; the ratio shows the book aggregate
    "Each row's miss looks small; the ratio shows book-scale impact.", // 10
    // angle: per-row interpretation — naive miss → mispricing → PnL
    "Naive's per-row miss is mispricing a hedger books against you.", // 10
    // angle: distilled comparison — same fitter, different commit, different cost
    "Same fitter, different commit. The ratio is the cost of that choice.", // 12
  ],
  // §Mismark sparkline — trace shape over the last sixty seconds.
  "mismark-sparkline": [
    // angle: tail vs average — what risk managers actually price
    "The tail names the worst frame; the average hides it.", // 10
    // angle: Oracaus's flatness — structural, not statistical
    "Oracaus's trace stays flat — coherence is structural, not statistical.", // 10
    // angle: naive's spike shape — episodic queue-drain dynamics
    "When naive spikes, that's its queue catching up — the failure isn't gradual.", // 13
  ],
};

// Variant id space per input. Acks are deliberately single-variant —
// users want the same confirmation phrasing for the same action; only
// the scenario / event paths rotate.
function variantIdsFor(input: SchedulerInput): readonly string[] {
  switch (input.kind) {
    case "event": {
      const count = EVENT_VARIANTS[input.event.type].length;
      return Array.from(
        { length: count },
        (_, i) => `event-${input.event.type}-v${i + 1}`,
      );
    }
    case "scenario-entry": {
      const count = SCENARIO_ENTRY_VARIANTS[input.scenario].length;
      return Array.from(
        { length: count },
        (_, i) => `scenario-${input.scenario}-v${i + 1}`,
      );
    }
    case "settings-ack":
      return [`ack-${input.control}-v1`];
    case "region-insight": {
      const count = REGION_INSIGHT_VARIANTS[input.region].length;
      return Array.from(
        { length: count },
        (_, i) => `region-${input.region}-v${i + 1}`,
      );
    }
  }
}

// Pick the least-recently-fired variant that is outside its 60 s
// cooldown. `undefined` `lastFiredAtMs` (never fired) is the most-LRU
// outcome — never-fired wins over any fired-and-cooled variant.
// Returns `null` when every variant is in cooldown.
function pickVariantIndex(
  variantIds: readonly string[],
  context: PhrasePickContext,
): number | null {
  let bestIdx: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < variantIds.length; i += 1) {
    const id = variantIds[i];
    if (id === undefined) continue;
    const lastFired = context.lastFiredAtMs.get(id);
    if (
      lastFired !== undefined &&
      context.nowMs - lastFired < COOLDOWN_PHRASE_ID_MS
    ) {
      continue;
    }
    // Never-fired = score -Infinity (most LRU). Strict `<` so two
    // never-fired variants pick the lowest-index — the fresh-state
    // default is v1, v2, v3 in order.
    const score = lastFired ?? Number.NEGATIVE_INFINITY;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function buildPhraseAt(
  input: SchedulerInput,
  id: string,
  variantIdx: number,
): PhraseSpec {
  switch (input.kind) {
    case "event":
      return {
        id,
        text: EVENT_VARIANTS[input.event.type][variantIdx] ?? "",
        tier: input.event.tier,
        gapAfterMs: 0,
      };
    case "scenario-entry":
      return {
        id,
        text: SCENARIO_ENTRY_VARIANTS[input.scenario][variantIdx] ?? "",
        tier: input.tier,
        gapAfterMs: 0,
      };
    case "settings-ack":
      return {
        id,
        text: ackText(input.control, input.value),
        tier: 1,
        gapAfterMs: 0,
      };
    case "region-insight":
      return {
        id,
        text: REGION_INSIGHT_VARIANTS[input.region][variantIdx] ?? "",
        tier: input.tier,
        gapAfterMs: 0,
      };
  }
}

export function createStubPhraseLibrary(): PhraseLibrary {
  return {
    pickPhrase(input: SchedulerInput, context: PhrasePickContext) {
      const variantIds = variantIdsFor(input);
      const idx = pickVariantIndex(variantIds, context);
      if (idx === null) return null;
      const id = variantIds[idx];
      if (id === undefined) return null;
      return buildPhraseAt(input, id, idx);
    },
  };
}
