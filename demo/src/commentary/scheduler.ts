// Priority-queue scheduler — unifies scenario-entry inputs (from the
// settler) and event inputs (from the detector) behind a single
// playback contract. Closure-stateful factory; caller injects `nowMs`.
// OBSERVATION-only — INTRO is a scripted phase-tied sequence and
// doesn't enter the queue.
//
// ## Design contract
//
// 1. **Four-bucket priority queue** (T1, T2, T3, T4). FIFO within
//    bucket by `timestamp`.
//
// 2. **`tick(nowMs)` returns a `TickDecision`** —
//    `{ kind: "play", phrase, preempt }` | `{ kind: "wait" }` |
//    `{ kind: "idle" }`. The hook invokes the phrase-sequencer; on
//    completion, calls `notifyPhraseCompleted` so the next `tick` can
//    dequeue.
//
// 3. **Preemption**: a T1 input arriving while a T2-T4 phrase is
//    in-flight wins. T1 vs T1: FIFO — preempting T1 with T1 would
//    create cancel-storms.
//
// 4. **Stale-event aging**: drop inputs when
//    `nowMs - input.timestamp > MAX_AGE_BY_TIER[tier]`
//    (T1=30s, T2=20s, T3=10s, T4=5s). Handles "tab hidden for minutes
//    then resumed" naturally — first post-resume tick drops stale.
//
// 5. **Pluggable phrase library** via `PhraseLibrary.pickPhrase(input,
//    context)`. Returns the chosen `PhraseSpec` or `null` when every
//    variant is in cooldown.
//
// 6. **Per-phrase-id cooldown, 60 s.** Composes with the detector's
//    per-event-type cooldown (which gates emission); this one gates
//    re-use of the same phrase variant.
//
// 7. **Variant selection at dequeue time, not enqueue.** Picks against
//    the latest cooldown state — if an input waited while preemption
//    resolved, the freshest info applies.
//
// 8. **Tab-visibility coordination is the hook's job** — scheduler
//    doesn't track pause state. The hook freezes its `tick` calls
//    while not in OBSERVATION; stale events drop via aging on resume.
//
// 9. **cancelAll** drops queue + in-flight + recent-fires log;
//    PRESERVES `lastFiredAtMs` (so settings-ack cancels don't unlock a
//    flood of repeats). Returns dropped count for diagnostics.
//
// 10. **Caller passes non-decreasing `nowMs`**. Backward clocks make
//     cooldowns appear elapsed; no defensive clamp.
//
// 11. **O(1) memory**: bounded queue (oldest age-dropped), one
//     in-flight ref, `Map<phraseId, lastFiredAtMs>` (bounded by
//     library size), `RECENT_FIRES_LIMIT = 6` circular array.

import type { CommentaryEvent, EventTier } from "./events.js";
import type { PhraseSpec } from "./phrase-sequencer.js";
import type { RegionId } from "./region.js";
import type { Scenario } from "./scenarios.js";

/**
 * Settings control behind a cancel-on-settings ack. Includes
 * `repairMode` (which `ControlChanged` excludes — it has its own
 * `IntentToggle` event); the immediate ack treats all four uniformly.
 */
export type SettingsAckControl =
  | "tickHz"
  | "expiries"
  | "repairMode"
  | "displayMaturityYears";

/**
 * Scheduler input. Events, scenario entries, and settings acks all
 * flow through the same queue. Settings-acks are always Tier 1 — they
 * preempt any in-flight T2–4 phrase to give the user instant feedback
 * on a settings click.
 */
export type SchedulerInput =
  | { readonly kind: "event"; readonly event: CommentaryEvent }
  | {
      readonly kind: "scenario-entry";
      readonly scenario: Scenario;
      readonly tier: EventTier;
      readonly timestamp: number;
    }
  | {
      readonly kind: "settings-ack";
      readonly control: SettingsAckControl;
      readonly value: number | "on" | "off";
      readonly timestamp: number;
    }
  | {
      /**
       * Stage 11 pointer-aware insight. Hook enqueues this on a debouncer
       * commit-change after the polite-enqueue check (Stage 11.6). Phrase
       * ids follow `region-{regionId}-v{n}` (Stage 11.4). Tier is locked
       * to T3 — T2 would preempt scenario phrases, contradicting the
       * polite-enqueue principle (insights yield to scenarios + events).
       * The visibility floor for longer phrases (12–13 words) is handled
       * by `computeDismissMs` via `max(tier-min, reading-time + grace)`,
       * so locking to T3 doesn't shorten the on-screen window.
       */
      readonly kind: "region-insight";
      readonly region: RegionId;
      readonly tier: 3;
      readonly timestamp: number;
    };

export interface PhrasePickContext {
  /** Newest first; bounded by `RECENT_FIRES_LIMIT`. */
  readonly recentlyFiredIds: readonly string[];
  readonly lastFiredAtMs: ReadonlyMap<string, number>;
  readonly nowMs: number;
}

export interface PhraseLibrary {
  /** Returns `null` when every candidate variant is in cooldown — the scheduler drops the input. */
  pickPhrase(
    input: SchedulerInput,
    context: PhrasePickContext,
  ): PhraseSpec | null;
}

export type TickDecision =
  /** Run the phrase; cancel the in-flight one first if `preempt`. */
  | {
      readonly kind: "play";
      readonly phrase: PhraseSpec;
      readonly preempt: boolean;
    }
  /** Something queued, but in-flight outranks. Caller continues current; queued plays later. */
  | { readonly kind: "wait" }
  /** Queue empty + no in-flight. */
  | { readonly kind: "idle" };

export interface TickResult {
  readonly decision: TickDecision;
  /** Inputs removed this tick (stale by age, or all variants in cooldown). */
  readonly dropped: number;
}

export interface Scheduler {
  enqueue(input: SchedulerInput, nowMs: number): void;
  tick(nowMs: number): TickResult;
  notifyPhraseStarted(phraseId: string, tier: EventTier, nowMs: number): void;
  /**
   * Clears in-flight only if `phraseId` matches the current in-flight
   * record — late completions for preempted phrases are ignored so
   * the replacement stays registered.
   */
  notifyPhraseCompleted(phraseId: string, nowMs: number): void;
  /**
   * Drops the queue + clears in-flight + clears recent-fires log.
   * Preserves `lastFiredAtMs` — a settings-ack-driven cancel must not
   * unlock a flood of repeats. Returns the count of dropped inputs.
   */
  cancelAll(): number;
  /**
   * Total inputs pending across all four tier buckets. Stage 11.6
   * uses this for the polite-enqueue rule (region-insight inputs are
   * dropped at the hook when the scheduler isn't idle). Read-only;
   * does not mutate state.
   */
  getQueueDepth(): number;
}

// Per-tier age cap before drop. Gradient reflects time-sensitivity —
// a T1 critical event is still worth narrating 30 s late; a T4
// control-change observation 5 s late is stale chatter.
export const MAX_AGE_BY_TIER: Readonly<Record<EventTier, number>> = {
  1: 30_000,
  2: 20_000,
  3: 10_000,
  4: 5_000,
};

// Minimum spacing between two emissions of the same phrase id.
export const COOLDOWN_PHRASE_ID_MS = 60_000;

// Larger → stronger variety pressure (library reaches further back for
// a fresh variant); smaller → more aggressive reuse.
export const RECENT_FIRES_LIMIT = 6;

// Settings-ack inputs are hardcoded to Tier 1 — see §2 (preemption).
// Region-insight inputs are T3-locked at the type level (Stage 11.4
// scrutiny — T2 would preempt scenarios, violating polite-enqueue).
function inputTier(input: SchedulerInput): EventTier {
  switch (input.kind) {
    case "event":
      return input.event.tier;
    case "scenario-entry":
      return input.tier;
    case "settings-ack":
      return 1;
    case "region-insight":
      return input.tier;
  }
}

function inputTimestamp(input: SchedulerInput): number {
  switch (input.kind) {
    case "event":
      return input.event.timestamp;
    case "scenario-entry":
      return input.timestamp;
    case "settings-ack":
      return input.timestamp;
    case "region-insight":
      return input.timestamp;
  }
}

export function createScheduler(library: PhraseLibrary): Scheduler {
  // Tier 1 = highest priority; FIFO within bucket. Plain arrays — the
  // queue is small enough that O(n) shift is fine.
  const buckets: Record<EventTier, SchedulerInput[]> = {
    1: [],
    2: [],
    3: [],
    4: [],
  };

  const lastFiredAtMs = new Map<string, number>();
  let recentlyFiredIds: string[] = [];
  // `tier` is the preemption comparand; `phraseId` matches late
  // completions to the right in-flight record.
  let inFlight: {
    readonly phraseId: string;
    readonly tier: EventTier;
  } | null = null;

  return {
    enqueue(input, _nowMs) {
      const tier = inputTier(input);
      buckets[tier].push(input);
    },

    tick(nowMs) {
      let dropped = 0;

      // Drop stale inputs before phrase-picking so the library isn't
      // wasted on inputs we're about to discard. Strict `>` (not `>=`)
      // gives the caller one tick of grace at the boundary.
      for (const tierKey of [1, 2, 3, 4] as const) {
        const bucket = buckets[tierKey];
        const maxAge = MAX_AGE_BY_TIER[tierKey];
        for (let i = bucket.length - 1; i >= 0; i -= 1) {
          const item = bucket[i];
          if (item === undefined) continue;
          if (nowMs - inputTimestamp(item) > maxAge) {
            bucket.splice(i, 1);
            dropped += 1;
          }
        }
      }

      // Preemption gate. With an in-flight phrase, only T1 inputs may
      // dequeue — and only against a T2-T4 in-flight. T1-vs-T1 stays
      // FIFO (preempting T1 with T1 would cause cancel-storms on
      // cascade events).
      if (inFlight !== null) {
        // Drain cooled-out T1 inputs in this same tick so a playable
        // T1 right behind a cooled one doesn't wait 200 ms.
        if (inFlight.tier > 1) {
          const t1Bucket = buckets[1];
          while (t1Bucket.length > 0) {
            const next = t1Bucket[0];
            if (next === undefined) break;
            t1Bucket.shift();
            const phrase = library.pickPhrase(next, {
              recentlyFiredIds,
              lastFiredAtMs,
              nowMs,
            });
            if (phrase !== null) {
              return {
                decision: { kind: "play", phrase, preempt: true },
                dropped,
              };
            }
            // Cooled out — drop and try the next T1 in the same tick.
            dropped += 1;
          }
        }
        // T1 bucket drained without a playable input, OR in-flight is
        // T1 (same-tier FIFO). Wait for completion.
        return { decision: { kind: "wait" }, dropped };
      }

      // No in-flight: walk buckets in priority order. Library returning
      // null means all variants cooled out — drop the input and try
      // the next one.
      for (const tierKey of [1, 2, 3, 4] as const) {
        const bucket = buckets[tierKey];
        while (bucket.length > 0) {
          const next = bucket[0];
          if (next === undefined) break;
          bucket.shift();

          const phrase = library.pickPhrase(next, {
            recentlyFiredIds,
            lastFiredAtMs,
            nowMs,
          });
          if (phrase === null) {
            // Cooldown-saturated — drop and try the next input in the
            // same bucket (or fall through to lower-tier buckets).
            dropped += 1;
            continue;
          }
          return {
            decision: { kind: "play", phrase, preempt: false },
            dropped,
          };
        }
      }

      return { decision: { kind: "idle" }, dropped };
    },

    notifyPhraseStarted(phraseId, tier, nowMs) {
      lastFiredAtMs.set(phraseId, nowMs);
      // Dedup before trim — a phrase firing twice (past cooldown)
      // shouldn't occupy two slots and evict unrelated LRU entries.
      recentlyFiredIds = [
        phraseId,
        ...recentlyFiredIds.filter((id) => id !== phraseId),
      ].slice(0, RECENT_FIRES_LIMIT);
      inFlight = { phraseId, tier };
    },

    notifyPhraseCompleted(phraseId, _nowMs) {
      // Late completions for preempted phrases are ignored — only the
      // current in-flight clears.
      if (inFlight !== null && inFlight.phraseId === phraseId) {
        inFlight = null;
      }
    },

    cancelAll() {
      // Preserves `lastFiredAtMs` for already-fired phrases so a
      // settings-ack cancel doesn't unlock a flood of repeats —
      // EXCEPT for the in-flight phrase, which was interrupted before
      // it could actually play and shouldn't count against cooldown.
      let totalDropped = 0;
      for (const tierKey of [1, 2, 3, 4] as const) {
        totalDropped += buckets[tierKey].length;
        buckets[tierKey].length = 0;
      }
      if (inFlight !== null) {
        lastFiredAtMs.delete(inFlight.phraseId);
      }
      inFlight = null;
      recentlyFiredIds = [];
      return totalDropped;
    },

    getQueueDepth() {
      return (
        buckets[1].length +
        buckets[2].length +
        buckets[3].length +
        buckets[4].length
      );
    },
  };
}
