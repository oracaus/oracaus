// Commentary orchestrator hook. Owns the phase machine, drives the
// scenario settler + event detector + scheduler, and exposes a toast
// stream + on/off toggle. App.tsx is the consumer.
//
// Phase machine: BOOT → INTRO → OBSERVATION ⇄ PAUSED. `enabled` is a
// separate session-state flag, orthogonal to phase (no persistence).
//
// Key invariants:
//
//   - INTRO is one-shot. Intent (settings change or pause toggle)
//     during INTRO dispatches INTRO_INTERRUPTED → OBSERVATION; the
//     300 ms debounced ack fires for the changed control. The
//     "don't replay INTRO" rule also applies on PAUSED + TAB_VISIBLE.
//   - Recording mode (`?mode=recording`) keeps INTRO uninterruptable
//     and forces `enabled=true`; the consumer hides the toolbar toggle.
//   - When `enabled=false`, the OBSERVATION-tick body is skipped
//     entirely — detector, settler, and scheduler all freeze. The
//     scenario-entry that would have fired during pause re-emerges
//     on resume because `prevSettledScenarioRef` is untouched.
//   - Toolbar toggle off mid-INTRO dispatches INTRO_INTERRUPTED so a
//     subsequent toggle-on doesn't replay phrase 1.
//   - Settler / detector / scheduler are ref-bootstrapped lazily so
//     they survive Strict-Mode's double-mount.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { trackEvent } from "../analytics.js";
import type {
  CommentaryTier,
  CommentaryToastInstance,
  CommentaryUtterance,
} from "../components/CommentaryToast.js";
import {
  createEventDetector,
  type EventDetector,
  type EventSnapshot,
  type SurfaceArbStatus,
} from "./events.js";
import { INITIAL_PHASE_STATE, phaseReducer } from "./phase-reducer.js";
import {
  createStubPhraseLibrary,
  SCENARIO_ENTRY_TIER,
} from "./phrase-library.js";
import {
  type CancelToken,
  type PhraseSpec,
  runPhraseSequence,
} from "./phrase-sequencer.js";
import {
  createRegionSettler,
  type RegionId,
  type RegionSettler,
} from "./region.js";
import {
  type AppSnapshot,
  createScenarioSettler,
  type Scenario,
  type ScenarioSettler,
} from "./scenarios.js";
import { createScheduler, type Scheduler } from "./scheduler.js";

/**
 * Phase machine states. See module header for the transition diagram.
 */
export type CommentaryPhase = "BOOT" | "INTRO" | "OBSERVATION" | "PAUSED";

/**
 * Options passed into the hook from `App.tsx`. Demo-state primitives drive
 * the scenario detector; test-injection fields let the hook be exercised
 * without a real browser.
 */
export interface UseCommentaryOptions {
  readonly shockActive: boolean;
  readonly tickHz: number;
  readonly expiries: number;
  readonly repairMode: "on" | "off";
  /**
   * Fraction (0–1) of strikes on the displayed naive slice whose
   * |IV miss| exceeds the demo's "torn" threshold. Feeds the
   * `TearStart` / `TearRecovery` sustained-threshold buffers. Default 0.
   */
  readonly tornFraction?: number;
  /**
   * Naive panel's structural lag — gap between displayed input view
   * and displayed fit in feed ticks. Computed via
   * `computeSnapshotLag("naive", ...)` in `App.tsx` (see
   * `demo/src/metrics.ts` for the per-mode formula). Pairs with
   * `tornFraction` to gate `TearRecovery` — see
   * `events.ts:NAIVE_LAG_RECOVERY_THRESHOLD`. Default 0 (no lag).
   */
  readonly naiveLagTicks?: number;
  /** Naive panel's pending-fit queue depth. Default 0. */
  readonly pendingCount?: number;
  /** Calendar-arb repair status from the worker. Default `"arb-free"`. */
  readonly surfaceArbStatus?: SurfaceArbStatus;
  /** Currently-displayed slice tenor in years. Default 1. */
  readonly displayMaturityYears?: number;
  /** Override URL-derived recording-mode detection. Default: read from `window.location.search`. */
  readonly recordingMode?: boolean;
  /** Wall-clock provider — tests inject a virtual clock. Default: `Date.now`. */
  readonly now?: () => number;
  /** Override the settler tick interval (ms). Default: 200 ms (5 Hz). */
  readonly settlerTickMs?: number;
  /**
   * Stage 11 — pointer-aware insight narration. Region currently under
   * the user's pointer, `null` when nothing is hovered. The hook's
   * region settler debounces this on a 1.5 s dwell (+ 500 ms exit
   * grace); a stable hover commits, and the polite-enqueue rule
   * decides whether to fire an insight toast. See
   * `createRegionSettler` in `region.ts` for the state machine.
   */
  readonly hoveredRegion?: RegionId | null;
}

export interface UseCommentaryResult {
  readonly phase: CommentaryPhase;
  readonly enabled: boolean;
  /** Toggling off cancels in-flight narration; off-during-INTRO routes phase to OBSERVATION. No-op in recording mode. */
  readonly toggleEnabled: () => void;
  /** Newest at index 0; capacity capped at `MAX_VISIBLE_TOASTS`. */
  readonly toasts: readonly CommentaryToastInstance[];
  /**
   * Stage 11 — currently-committed region (post-1.5 s dwell,
   * pre-500 ms exit grace). `null` when nothing is committed.
   *
   * The hook populates this from `options.hoveredRegion` via the
   * region settler. App.tsx no longer consumes it for visual
   * purposes — the tint UI was reverted in 11.x follow-up after the
   * "guided-tour" aesthetic conflicted with the demo's
   * professional-workstation register. The field remains exposed:
   * - Tests assert against it to verify settler behaviour.
   * - Stage 12 may use it for recording-mode pointer-position
   *   playback (still TBD).
   */
  readonly committedRegion: RegionId | null;
}

// 5 Hz — sub-debounce-window (settler is 2 s) and sub-intent-window (4 s).
const DEFAULT_SETTLER_TICK_MS = 200;

// Stage 11.6 — polite-enqueue rule for region-insight inputs. The quiet
// window is one T3 tier-min cycle of breathing room AFTER the most
// recent fire (any phrase, any tier). Combined with the
// `toastsLength === 0` check, this covers all four tier visibility
// floors tier-agnostically: T1=8s, T2=6s, T3=5s, T4=4s — when no toast
// is visible AND ≥5 s have passed since the last fire, the system is
// genuinely quiet and an insight earns the slot.
export const INSIGHT_QUIET_WINDOW_MS = 5_000;

/**
 * Pure-function polite-enqueue check, extracted for unit testing.
 * Returns `true` only when the conditions of the Stage 11.6
 * polite-enqueue rule all pass. Otherwise the caller (the hook's
 * OBSERVATION-tick) drops the region-insight input silently.
 *
 * Rule (Stage 11.6 §narrative integration):
 *
 *   1. `phase === "OBSERVATION"` — INTRO and PAUSED ignore.
 *   2. `!recordingMode` — Stage 11.7 guard. Recording mode replays a
 *      deterministic narration arc; pointer events from a viewer don't
 *      enter the queue. The Stage 12 recording driver fires phrases
 *      directly via the scheduler's `enqueue` (or future `pushPhrase`
 *      escape hatch), bypassing this gate.
 *   3. `enabled` — commentary toggle off mutes everything.
 *   4. `toastsLength === 0 && queueDepth === 0` — nothing visible, no
 *      pending inputs.
 *   5. `nowMs - lastFireAtMs >= INSIGHT_QUIET_WINDOW_MS` — at least 5 s
 *      of breathing room since the most recent fire.
 */
export interface InsightEnqueueState {
  readonly phase: CommentaryPhase;
  readonly recordingMode: boolean;
  readonly enabled: boolean;
  readonly toastsLength: number;
  readonly queueDepth: number;
  readonly lastFireAtMs: number;
  readonly nowMs: number;
}

export function shouldEnqueueInsight(state: InsightEnqueueState): boolean {
  if (state.phase !== "OBSERVATION") return false;
  if (state.recordingMode) return false;
  if (!state.enabled) return false;
  if (state.toastsLength > 0) return false;
  if (state.queueDepth > 0) return false;
  if (state.nowMs - state.lastFireAtMs < INSIGHT_QUIET_WINDOW_MS) return false;
  return true;
}

const MAX_VISIBLE_TOASTS = 2;

// Time between `dismissAtMs` and actual removal — lets the leaving-state
// fade animation play before the toast disappears from the array.
const EXIT_ANIMATION_MS = 250;

// Per-tier floor for toast visibility. Actual dismiss is
// `max(tierMin, readingMs + grace)` so long phrases stay readable.
const DISMISS_TIER_MIN_MS: Record<CommentaryTier, number> = {
  1: 8_000, // critical
  2: 6_000, // transition
  3: 5_000, // comparison
  4: 4_000, // observation
  5: 3_000, // idle
};

const POST_READ_GRACE_MS = 1_500;

// Technical-content reading rate. Slower than the literature's "comfortable
// English silent reading" rate (~168 wpm) because financial-domain
// narration is dense with numerics, proper nouns, and inverted syntax
// ("Naive's queue at twenty") that suppress reading speed in practice.
const READING_WPM = 140;

function estimateReadingMs(text: string): number {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  if (words === 0) return 0;
  return Math.round((words * 60_000) / READING_WPM);
}

// Ack phrases (id prefix `ack-`) take T1 scheduler priority for preempt,
// but their visibility floor is T3's 5 s and their visual presentation
// is T4 muted — a 4-7 word confirmation ("Tick rate: one hundred")
// shouldn't sit on screen for T1's 8 s, and shouldn't paint in the
// critical-red wash that T1 events use either (acks are user-initiated
// observations of a control change, not critical alerts). Priority,
// visibility, and visual presentation are otherwise all on `tier`;
// acks are the one place we override two of those (visibility +
// visual) while keeping priority on T1 for preempt semantics.
function computeDismissMs(
  id: string,
  tier: CommentaryTier,
  text: string,
): number {
  const readMs = estimateReadingMs(text);
  const visibilityTier: CommentaryTier = id.startsWith("ack-") ? 3 : tier;
  return Math.max(
    DISMISS_TIER_MIN_MS[visibilityTier],
    readMs + POST_READ_GRACE_MS,
  );
}

// Visual tier override — mirrors the `computeDismissMs` ack carve-out
// for the dot colour + background tint. Acks paint as T4 (muted /
// observation register) regardless of the scheduler-priority tier.
function visualTierFor(id: string, tier: CommentaryTier): CommentaryTier {
  return id.startsWith("ack-") ? 4 : tier;
}

// Scripted scene-setters for the naive vs Oracaus comparison. Tier 4;
// word counts above the T4 5-9 target are accepted for the one-shot
// opening — dismiss math holds for reader-paced cadence.
const INTRO_PHRASES: readonly PhraseSpec[] = [
  {
    id: "intro-1", // PLAYBOOK §Demo narration ¶1 — scene + opt-out pointer
    tier: 4,
    text: "Synthetic option chain at fifty ticks per second. Same feed into two panels. Toggle commentary off in the toolbar if you'd rather watch quiet.",
    gapAfterMs: 600,
  },
  {
    id: "intro-2", // PLAYBOOK §Demo narration ¶2 — controlled experiment
    tier: 4,
    text: "Each panel: same SVI fit in a Web Worker. Same code, same compute time.",
    gapAfterMs: 600,
  },
  {
    id: "intro-3", // PLAYBOOK §Demo narration ¶3 — the difference, located
    tier: 4,
    text: "Difference is React-side: how each pairs the curve with the dots.",
    gapAfterMs: 600,
  },
  {
    id: "intro-4", // PLAYBOOK §Demo narration ¶4 — substrate thesis condensed
    tier: 4,
    text: "Naive composes whatever's ready. Oracaus emits only matching pairs.",
    gapAfterMs: 600,
  },
  {
    id: "intro-5", // PLAYBOOK §Demo narration ¶5 — watch instruction
    tier: 4,
    text: "Compare lag on both panels. Drift between dots and curve marks the failure mode.",
    gapAfterMs: 0,
  },
];

function detectRecordingModeFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("mode") === "recording";
  } catch {
    return false;
  }
}

export function useCommentary(
  options: UseCommentaryOptions,
): UseCommentaryResult {
  const recordingMode = options.recordingMode ?? detectRecordingModeFromUrl();

  const [state, dispatch] = useReducer(phaseReducer, INITIAL_PHASE_STATE);
  // Default ON. The bottom-positioned toast stack no longer obstructs
  // the smile/curve visual that the demo's central message depends on,
  // and the INTRO sequence is the only element that translates the
  // trader-jargon labels into plain English for visitors without
  // options-domain context (HN traffic, in particular). Senior
  // evaluators who prefer no narration use the toolbar toggle —
  // intro-1 points at it explicitly.
  const [enabled, setEnabled] = useState<boolean>(true);
  const [toasts, setToasts] = useState<readonly CommentaryToastInstance[]>([]);

  // Phrase ids are reused across firings (the scheduler keys cooldowns by
  // id), so two toasts in the stack may share `id`. `instanceId` keeps
  // React keys unique.
  const toastInstanceCounterRef = useRef(0);

  // Stage 11.6 — most-recent fire timestamp, fed by every `pushToast`
  // call (any phrase, any tier — insights gate themselves too via the
  // same window). Read by the polite-enqueue check in the OBSERVATION
  // tick. Sentinel `-Infinity` makes the first fire always pass the
  // 5 s post-fire gate.
  const lastFireAtMsRef = useRef<number>(Number.NEGATIVE_INFINITY);

  const pushToast = useCallback(
    (utterance: CommentaryUtterance | null) => {
      if (utterance === null) return;
      const now = options.now !== undefined ? options.now() : Date.now();
      lastFireAtMsRef.current = now;
      toastInstanceCounterRef.current += 1;
      const instanceId = `${utterance.id}#${toastInstanceCounterRef.current}`;
      const next: CommentaryToastInstance = {
        id: utterance.id,
        instanceId,
        text: utterance.text,
        tier: visualTierFor(utterance.id, utterance.tier),
        dismissAtMs:
          now + computeDismissMs(utterance.id, utterance.tier, utterance.text),
      };
      // Newest at the END of the array — bottom-anchored stack renders
      // in array order, so the newest toast sits closest to the slide-
      // source (bottom of viewport). `.slice(-MAX_VISIBLE_TOASTS)` keeps
      // the most recent N when the stack overflows.
      setToasts((prev) => [...prev, next].slice(-MAX_VISIBLE_TOASTS));
    },
    [options.now],
  );

  // Stage 11.6 — synchronous read of current `toasts` for the
  // polite-enqueue check inside the tick. React state is stale inside
  // `setInterval` closures; a ref kept in sync via effect is the
  // standard pattern.
  const toastsRef = useRef<readonly CommentaryToastInstance[]>([]);
  useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  // Dismiss-tick — drives the visible → leaving → removed transitions
  // by mutating the toast array. 100 ms is fine-grained enough for the
  // 250 ms exit animation to look smooth.
  useEffect(() => {
    const nowFn = options.now ?? Date.now;
    const tick = (): void => {
      const now = nowFn();
      setToasts((prev) => {
        let mutated = false;
        const next: CommentaryToastInstance[] = [];
        for (const t of prev) {
          if (now >= t.dismissAtMs + EXIT_ANIMATION_MS) {
            mutated = true;
            continue;
          }
          const shouldLeave = now >= t.dismissAtMs;
          if (shouldLeave && !t.leaving) {
            mutated = true;
            next.push({ ...t, leaving: true });
          } else {
            next.push(t);
          }
        }
        return mutated ? next : prev;
      });
    };
    const handle = setInterval(tick, 100);
    return (): void => {
      clearInterval(handle);
    };
  }, [options.now]);

  // Held in a ref so effect cleanups can flip cancellation without
  // restarting the effect.
  const activeSequenceTokenRef = useRef<CancelToken | null>(null);

  // Lazy-bootstrap pattern: refs survive Strict Mode's double-mount.
  const settlerRef = useRef<ScenarioSettler | null>(null);
  if (settlerRef.current === null) {
    settlerRef.current = createScenarioSettler();
  }
  const detectorRef = useRef<EventDetector | null>(null);
  if (detectorRef.current === null) {
    detectorRef.current = createEventDetector();
  }
  const schedulerRef = useRef<Scheduler | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = createScheduler(createStubPhraseLibrary());
  }
  // Stage 11.6 — region settler (dwell debounce + exit grace). Lazy-init
  // to survive Strict Mode double-mount, same as scenario settler.
  const regionSettlerRef = useRef<RegionSettler | null>(null);
  if (regionSettlerRef.current === null) {
    regionSettlerRef.current = createRegionSettler();
  }
  // Previous committed region — drives commit-change detection in the
  // OBSERVATION tick. `null` means "no previous commit observed".
  const previousRegionCommittedRef = useRef<RegionId | null>(null);
  // Stage 11.6 — has the insight fired for the *current* commit
  // identity? Allows polite-enqueue to be re-evaluated on every tick
  // while the user keeps hovering. If polite-enqueue fails at the
  // commit moment (e.g., a scenario phrase is on screen), the insight
  // isn't dropped permanently — it fires deferred once the system
  // quiets. Reset on every commit-change (including → null), so a
  // re-hover after leaving gets a fresh chance + LRU rotation.
  const insightFiredForCommitRef = useRef<boolean>(false);
  // Current committed region — exposed on the hook return for tests
  // + Stage 12. App.tsx does not consume this for visual purposes
  // (the tint UI was reverted; see UseCommentaryResult JSDoc on
  // `committedRegion`). Updated from the tick's commit-change branch.
  const [committedRegion, setCommittedRegion] = useState<RegionId | null>(null);

  // Enqueue scenario-entry only when the scenario changes (the settler
  // re-emits `settled` every tick).
  const prevSettledScenarioRef = useRef<Scenario | null>(null);

  const prevSettingsRef = useRef<{
    tickHz: number;
    expiries: number;
    repairMode: "on" | "off";
    displayMaturityYears: number;
  } | null>(null);
  const pendingAckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -Infinity sentinel makes `now - lastIntentTs` evaluate to Infinity
  // on first observation, which falls through the settler's <4_000ms
  // intent window cleanly.
  const lastIntentTsRef = useRef<number>(Number.NEGATIVE_INFINITY);
  const prevRepairModeRef = useRef<"on" | "off" | null>(null);
  useEffect(() => {
    if (prevRepairModeRef.current === null) {
      prevRepairModeRef.current = options.repairMode;
      return;
    }
    if (prevRepairModeRef.current !== options.repairMode) {
      const nowFn = options.now ?? Date.now;
      lastIntentTsRef.current = nowFn();
      prevRepairModeRef.current = options.repairMode;
    }
  }, [options.repairMode, options.now]);

  // Shock-edge interrupt. Shock is the demo's highest-impact moment;
  // its visual effects on the chart are immediate, so the toast must
  // land within the same render cycle. The default scheduler path
  // can stall by several seconds if a T1 phrase is already in flight
  // (T1-vs-T1 is FIFO by design — preventing cancel storms — but the
  // ack that fires after a settings change is T1 with a 5 s visibility
  // floor, so a shock click 1–2 s after a settings change waits for
  // the ack to dismiss before `ShockStart` plays).
  //
  // The fix is to clear the deck on the rising edge:
  //
  //   - **INTRO**: detector is dormant (OBSERVATION-tick effect isn't
  //     mounted yet). Dispatch INTRO_INTERRUPTED + cancel the active
  //     sequence token + synthesise the ShockStart input directly,
  //     because the detector's first call after the phase transition
  //     returns `[]` (it sets the baseline) and won't emit ShockStart
  //     for that bootstrap tick.
  //   - **OBSERVATION**: detector has been running and its `prev`
  //     state holds `shockActive: false`. We cancel the active
  //     sequence token + `scheduler.cancelAll()` (clears queue +
  //     in-flight) so nothing competes for the slot. The OBSERVATION-
  //     tick effect re-runs synchronously (its deps include
  //     `options.shockActive`), and on that tick the detector sees the
  //     edge and emits ShockStart naturally. Toast lands in ~30 ms.
  //
  // Recording-mode guard at top covers both phases — pointer-event
  // narration is suppressed during deterministic playback.
  const prevShockActiveRef = useRef<boolean>(options.shockActive);
  // biome-ignore lint/correctness/useExhaustiveDependencies: state.phase, recordingMode, enabled, and options.now read from closure to keep deps narrow.
  useEffect(() => {
    if (prevShockActiveRef.current === options.shockActive) return;
    const prev = prevShockActiveRef.current;
    prevShockActiveRef.current = options.shockActive;
    // Only react to the rising edge (user-driven shock click); the
    // falling edge (timer-driven shock end ~10s later) flows through
    // the detector naturally once OBSERVATION-tick is running.
    if (!options.shockActive || prev !== false) return;
    if (recordingMode) return;
    if (!enabled) return;
    if (state.phase !== "INTRO" && state.phase !== "OBSERVATION") return;

    const token = activeSequenceTokenRef.current;
    if (token !== null) token.cancelled = true;

    if (state.phase === "INTRO") {
      dispatch({ type: "INTRO_INTERRUPTED" });
      const now = (options.now ?? Date.now)();
      schedulerRef.current?.enqueue(
        {
          kind: "event",
          event: { type: "ShockStart", tier: 1, timestamp: now },
        },
        now,
      );
    } else {
      // OBSERVATION. Cancel-all clears any in-flight ack / scenario /
      // event so the imminent re-tick of the OBSERVATION-tick effect
      // can fire ShockStart from the detector's edge detection
      // uncontested.
      schedulerRef.current?.cancelAll();
    }
  }, [options.shockActive]);

  // Bootstrap. Strict Mode double-fires; the reducer's BOOT-only INIT
  // guard makes the second dispatch a no-op.
  useEffect(() => {
    dispatch({ type: "INIT" });
  }, []);

  // Unmount-only cleanup — prevents a late microtask from pushing a
  // toast after the hook is gone.
  useEffect(() => {
    return (): void => {
      activeSequenceTokenRef.current = { cancelled: true };
    };
  }, []);

  // INTRO sequencer driver. Completes → INTRO_DONE → OBSERVATION.
  useEffect(() => {
    if (state.phase !== "INTRO") return;
    if (!enabled) return;

    const token: CancelToken = { cancelled: false };
    activeSequenceTokenRef.current = token;
    const introStartedAt = (options.now ?? Date.now)();

    runPhraseSequence(INTRO_PHRASES, {
      token,
      setUtterance: (u) => {
        if (token.cancelled) return;
        pushToast(u);
      },
    })
      .then((outcome) => {
        if (token.cancelled) return;
        if (outcome === "ok") {
          trackEvent("intro-completed", {
            duration_ms: (options.now ?? Date.now)() - introStartedAt,
          });
          dispatch({ type: "INTRO_DONE" });
        }
      })
      .catch(() => {
        // Sequencer is total; guard defensively.
      });

    return (): void => {
      token.cancelled = true;
    };
  }, [state.phase, enabled, pushToast, options.now]);

  // OBSERVATION-phase tick driver. Snapshots app state, drives the
  // settler + detector, and runs scheduler.tick. Paused = no-op (see
  // `if (!enabled)` inside `tick`).
  useEffect(() => {
    if (state.phase !== "OBSERVATION") return;
    const tickMs = options.settlerTickMs ?? DEFAULT_SETTLER_TICK_MS;
    const nowFn = options.now ?? Date.now;
    const settler = settlerRef.current;
    const detector = detectorRef.current;
    const scheduler = schedulerRef.current;
    if (settler === null || detector === null || scheduler === null) return;

    const runPhrase = (phrase: PhraseSpec, nowAtTick: number): void => {
      const token: CancelToken = { cancelled: false };
      activeSequenceTokenRef.current = token;
      const phraseTier = (phrase.tier === 5 ? 4 : phrase.tier) as 1 | 2 | 3 | 4;
      scheduler.notifyPhraseStarted(phrase.id, phraseTier, nowAtTick);
      runPhraseSequence([phrase], {
        token,
        setUtterance: (u) => {
          if (token.cancelled) return;
          pushToast(u);
        },
      })
        .then(() => {
          scheduler.notifyPhraseCompleted(phrase.id, nowFn());
        })
        .catch(() => {
          scheduler.notifyPhraseCompleted(phrase.id, nowFn());
        });
    };

    const tick = (): void => {
      // Paused: freeze settler/detector/scheduler entirely. The current
      // scenario re-emits via `prevSettledScenarioRef` on resume.
      // Cooldowns + age-drop also freeze — fine for a marketing demo.
      if (!enabled) return;

      const now = nowFn();

      // Stage 11.6 — region settler step. Called only inside the
      // OBSERVATION tick (not during INTRO / PAUSED / disabled), so
      // internal settler state never accumulates outside the active
      // narration phase. A user who hovers through INTRO end gets the
      // insight ~1.5 s after OBSERVATION begins (fresh dwell from the
      // first OBSERVATION tick).
      //
      // The commit-change branch updates the committed-region state
      // (for downstream consumers / Stage 12) and resets the "fired
      // for this commit" flag. The polite-enqueue check then runs on
      // EVERY tick while a commit is active — so an insight that
      // can't fire at the commit moment (queue/toast busy, or within
      // the 5 s post-fire window) fires deferred once the system
      // quiets. Once fired, the flag prevents re-firing for the same
      // commit identity until the user leaves and re-hovers.
      const regionSettler = regionSettlerRef.current;
      if (regionSettler !== null) {
        const regionOut = regionSettler.update(
          options.hoveredRegion ?? null,
          now,
        );
        const prevCommitted = previousRegionCommittedRef.current;
        const currCommitted = regionOut.committed;
        if (currCommitted !== prevCommitted) {
          previousRegionCommittedRef.current = currCommitted;
          setCommittedRegion(currCommitted);
          insightFiredForCommitRef.current = false;
        }
        if (
          currCommitted !== null &&
          !insightFiredForCommitRef.current &&
          shouldEnqueueInsight({
            phase: state.phase,
            recordingMode,
            enabled,
            toastsLength: toastsRef.current.length,
            queueDepth: scheduler.getQueueDepth(),
            lastFireAtMs: lastFireAtMsRef.current,
            nowMs: now,
          })
        ) {
          scheduler.enqueue(
            {
              kind: "region-insight",
              region: currCommitted,
              tier: 3,
              timestamp: now,
            },
            now,
          );
          insightFiredForCommitRef.current = true;
        }
      }

      const appSnapshot: AppSnapshot = {
        shockActive: options.shockActive,
        tickHz: options.tickHz,
        expiries: options.expiries,
        lastIntentToggleAgoMs: now - lastIntentTsRef.current,
      };

      const eventSnapshot: EventSnapshot = {
        shockActive: options.shockActive,
        tornFraction: options.tornFraction ?? 0,
        naiveLagTicks: options.naiveLagTicks ?? 0,
        pendingCount: options.pendingCount ?? 0,
        surfaceArbStatus: options.surfaceArbStatus ?? "arb-free",
        repairMode: options.repairMode,
        tickHz: options.tickHz,
        expiries: options.expiries,
        displayMaturityYears: options.displayMaturityYears ?? 1,
      };

      const settlerOut = settler.update(appSnapshot, now);
      if (settlerOut.type === "settled") {
        dispatch({ type: "SCENARIO_SETTLED", scenario: settlerOut.scenario });
        if (prevSettledScenarioRef.current !== settlerOut.scenario) {
          prevSettledScenarioRef.current = settlerOut.scenario;
          scheduler.enqueue(
            {
              kind: "scenario-entry",
              scenario: settlerOut.scenario,
              tier: SCENARIO_ENTRY_TIER[settlerOut.scenario],
              timestamp: now,
            },
            now,
          );
        }
      }

      const events = detector.update(eventSnapshot, now);
      for (const event of events) {
        scheduler.enqueue({ kind: "event", event }, now);
      }

      const result = scheduler.tick(now);
      if (result.decision.kind === "play") {
        if (result.decision.preempt) {
          const token = activeSequenceTokenRef.current;
          if (token !== null) token.cancelled = true;
        }
        runPhrase(result.decision.phrase, now);
      }
    };

    tick();
    const handle = setInterval(tick, tickMs);
    return (): void => {
      clearInterval(handle);
    };
  }, [
    state.phase,
    enabled,
    recordingMode,
    options.shockActive,
    options.tickHz,
    options.expiries,
    options.repairMode,
    options.tornFraction,
    options.naiveLagTicks,
    options.pendingCount,
    options.surfaceArbStatus,
    options.displayMaturityYears,
    options.hoveredRegion,
    options.now,
    options.settlerTickMs,
    pushToast,
  ]);

  // Cancel-on-settings. Fires during INTRO or OBSERVATION (gated by
  // `enabled` + `!recordingMode`). INTRO path dispatches
  // INTRO_INTERRUPTED so the 300 ms ack lands as if we were in
  // OBSERVATION all along.
  // biome-ignore lint/correctness/useExhaustiveDependencies: phase / enabled / recordingMode are read from the closure to keep deps narrow.
  useEffect(() => {
    const live = {
      tickHz: options.tickHz,
      expiries: options.expiries,
      repairMode: options.repairMode,
      displayMaturityYears: options.displayMaturityYears ?? 1,
    };

    if (prevSettingsRef.current === null) {
      prevSettingsRef.current = live;
      return;
    }

    const prev = prevSettingsRef.current;
    let changedControl:
      | "tickHz"
      | "expiries"
      | "repairMode"
      | "displayMaturityYears"
      | null = null;
    let changedValue: number | "on" | "off" = 0;
    if (prev.tickHz !== live.tickHz) {
      changedControl = "tickHz";
      changedValue = live.tickHz;
    } else if (prev.expiries !== live.expiries) {
      changedControl = "expiries";
      changedValue = live.expiries;
    } else if (prev.repairMode !== live.repairMode) {
      changedControl = "repairMode";
      changedValue = live.repairMode;
    } else if (prev.displayMaturityYears !== live.displayMaturityYears) {
      changedControl = "displayMaturityYears";
      changedValue = live.displayMaturityYears;
    }
    prevSettingsRef.current = live;

    if (changedControl === null) return;
    if (state.phase !== "OBSERVATION" && state.phase !== "INTRO") return;
    if (recordingMode) return;
    if (!enabled) return;

    if (state.phase === "INTRO") {
      dispatch({ type: "INTRO_INTERRUPTED" });
    }

    schedulerRef.current?.cancelAll();
    const token = activeSequenceTokenRef.current;
    if (token !== null) token.cancelled = true;

    if (pendingAckTimerRef.current !== null) {
      clearTimeout(pendingAckTimerRef.current);
    }
    const ackControl = changedControl;
    const ackValue = changedValue;
    pendingAckTimerRef.current = setTimeout(() => {
      pendingAckTimerRef.current = null;
      schedulerRef.current?.enqueue(
        {
          kind: "settings-ack",
          control: ackControl,
          value: ackValue,
          timestamp: (options.now ?? Date.now)(),
        },
        (options.now ?? Date.now)(),
      );
    }, 300);
  }, [
    options.tickHz,
    options.expiries,
    options.repairMode,
    options.displayMaturityYears,
    options.now,
  ]);

  // Unmount-only cleanup for the debounce timer.
  useEffect(() => {
    return (): void => {
      if (pendingAckTimerRef.current !== null) {
        clearTimeout(pendingAckTimerRef.current);
        pendingAckTimerRef.current = null;
      }
    };
  }, []);

  // Drop a pending ack-debounce when commentary becomes unable to play
  // it (phase shift, recording mode on, paused) — prevents a stale ack
  // firing onto a surface that won't render it.
  useEffect(() => {
    if (state.phase !== "OBSERVATION" || recordingMode || !enabled) {
      if (pendingAckTimerRef.current !== null) {
        clearTimeout(pendingAckTimerRef.current);
        pendingAckTimerRef.current = null;
      }
    }
  }, [state.phase, recordingMode, enabled]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = (): void => {
      if (document.visibilityState === "hidden") {
        const token = activeSequenceTokenRef.current;
        if (token !== null) token.cancelled = true;
        dispatch({ type: "TAB_HIDDEN" });
      } else if (document.visibilityState === "visible") {
        dispatch({ type: "TAB_VISIBLE" });
      }
    };
    document.addEventListener("visibilitychange", handler);
    return (): void => {
      document.removeEventListener("visibilitychange", handler);
    };
  }, []);

  const toggleEnabled = useCallback((): void => {
    if (recordingMode) return;
    setEnabled((current) => {
      const next = !current;
      if (!next) {
        if (state.phase === "INTRO") {
          dispatch({ type: "INTRO_INTERRUPTED" });
        }
        schedulerRef.current?.cancelAll();
        const token = activeSequenceTokenRef.current;
        if (token !== null) token.cancelled = true;
        setToasts([]);
      }
      return next;
    });
  }, [recordingMode, state.phase]);

  // Stage 11.6 — reset region state on any transition out of the
  // "active narration" state (OBSERVATION + enabled). Includes:
  //   - OBSERVATION → PAUSED / INTRO / BOOT (phase change)
  //   - commentary toggle off (enabled becomes false)
  // Each transition clears the settler's internal pending / committed /
  // exiting state, resets the previous-committed marker, and clears the
  // exposed `committedRegion`. On the next active transition the user
  // starts a fresh dwell — same path as a first-time visitor entering
  // OBSERVATION.
  const wasActiveRegionRef = useRef<boolean>(false);
  useEffect(() => {
    const isActive = state.phase === "OBSERVATION" && enabled;
    if (wasActiveRegionRef.current && !isActive) {
      regionSettlerRef.current?.reset();
      previousRegionCommittedRef.current = null;
      insightFiredForCommitRef.current = false;
      setCommittedRegion(null);
    }
    wasActiveRegionRef.current = isActive;
  }, [state.phase, enabled]);

  return {
    phase: state.phase,
    enabled,
    toggleEnabled,
    toasts,
    committedRegion,
  };
}
