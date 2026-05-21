// Event detector — discrete events fired by edges + sustained-threshold
// transitions in `EventSnapshot`. Sibling of `scenarios.ts` (macro
// scenario classification); the two run concurrently and feed the
// scheduler's queue independently.
//
// `createEventDetector()` is a closure-stateful factory returning
// `update(snapshot, nowMs): readonly CommentaryEvent[]`. Caller injects
// `nowMs`; tests use virtual clocks.
//
// ## Design contract
//
// 1. **Edge detection by stored prev.** Detector tracks the previous
//    snapshot internally. Edges fire on `prev[X] !== snapshot[X]` for
//    boolean / string fields. Threshold-crossings fire on
//    `prev < threshold && snapshot >= threshold`.
//
// 2. **Sustained-threshold events** (`TearStart`, `TearRecovery`)
//    tracked via two candidate timestamps + two per-direction "fired"
//    flags. `tearStartSinceMs` is set when `tornFraction` first crosses
//    `TEAR_START_THRESHOLD`; cleared on natural rearm (dip below) OR
//    on fire. `tearStartFired` stays true while torn — full
//    edge-of-state semantics on top of sustained detection.
//    `TearRecovery` mirrors with `<= TEAR_RECOVERY_THRESHOLD` AND
//    requires (a) a `recoveryPending` flag set by a prior TearStart
//    detection and (b) `naiveLagTicks <= NAIVE_LAG_RECOVERY_THRESHOLD`
//    so a momentary `tornFraction` dip while naive is architecturally
//    still behind doesn't fire a fluke recovery.
//
// 3. **"Fires once per sustained period" is load-bearing.** Without
//    the fired flag, a held high `tornFraction` would re-buffer-and-
//    re-fire every `TEAR_SUSTAINED_MS + cooldown` (~5–8 s during
//    prolonged tearing). Cooldown is a backstop for near-edge
//    flapping, NOT for prolonged state-holding.
//
// 4. **Strict sustained semantics** (single-dip resets the buffer).
//    Hysteresis (sub-threshold for ≥500 ms resets) is a candidate
//    refinement if playthrough polish reveals false negatives.
//
// 5. **Cooldowns per event-type or per-control-id.** Most events
//    share a single per-type map. `ControlChanged` uses a separate
//    per-control-id map so tickHz and expiries can fire in rapid
//    sequence (distinct controls). `IntentToggle` is per-type — a
//    rapid off→on→off narrates only the first transition.
//
// 6. **Bootstrap.** First `update()` returns `[]` and stores `prev`.
//    Sustained-threshold candidates DO set on bootstrap (buffer
//    starts running) but can't mature until ≥`TEAR_SUSTAINED_MS`
//    later. Callers must invoke `update()` regularly to maintain
//    `prev` and expire pending buffers.
//
// 7. **Cooldown vs. internal state are orthogonal.** Cooldown
//    suppresses *emission only*. Edge prev-references, sustained
//    candidates + fired flags, and change-detection prev-values
//    advance unconditionally — so a `TearStart` suppressed by
//    cooldown still flips `tearStartFired` (detection ran, narration
//    didn't), and `prev` always rolls forward.
//
// 8. **Multiple events per update.** When several conditions fire in
//    one transition, the detector returns all of them. Ordering: by
//    `tier` ascending; ties broken alphabetically. Convention only —
//    the scheduler re-sorts by its own rules.
//
// 9. **`IntentToggle` vs `ControlChanged`.** Only `repairMode` change
//    emits `IntentToggle` (Tier 3 — substrate-parallel narration).
//    `tickHz` / `expiries` / `displayMaturityYears` emit
//    `ControlChanged` (Tier 4 — observation).
//
// 10. **`surfaceArbStatus` asymmetry — only `RepairFailed` narrates.**
//     Four values: `arb-free | repair-applied | repair-failed |
//     arb-violation`. `repair-applied` and `arb-violation` (the latter
//     fires when the user has chosen `repairMode = "off"` and the
//     surface has detected violations) are intentionally silent —
//     `arb-violation` is user-elected risk, not an unprompted failure,
//     and the toolbar toggle is the visible cause. Only the
//     `repair-failed` transition (repair attempted and exhausted)
//     gets a narration.
//
// 11. **Detector is unaware of the `enabled` toggle.** Emits events
//     regardless; the hook's OBSERVATION-tick decides whether to
//     consume them.
//
// 12. **Backward clocks** aren't defended — they manifest as
//     cooldowns appearing already elapsed. The demo never regresses
//     its clock.
//
// 13. **Cancel-on-settings is a separate path.** The hook listens
//     to settings primitives directly for the immediate Tier-1
//     ack + cancel. `IntentToggle` / `ControlChanged` here are a
//     follow-up thread (Tier 3/4) for phrases that play later.

/**
 * Status of the surface's arbitrage state after the current tick's
 * calendar-arb check / repair pipeline. Re-exported from `svi/no-arb.ts`
 * to keep the commentary layer's type imports flat — see that module
 * for the discrete values and the production-realistic semantics
 * (CLAUDE.md §Calendar-arb repair pipeline).
 */
import type { SurfaceArbStatus } from "../svi/no-arb.js";

export type { SurfaceArbStatus };

/**
 * Tier values an event may carry. Strict subset of `CommentaryTier`
 * (events never fire at T5; T5 is reserved for ambient idle filler).
 * Distinct type name avoids import-collision with `CommentaryTier`.
 */
export type EventTier = 1 | 2 | 3 | 4;

/**
 * Toolbar control behind a `ControlChanged` event. Excludes
 * `repairMode` (emits `IntentToggle` — design contract §9).
 */
export type ControlId = "tickHz" | "expiries" | "displayMaturityYears";

/**
 * Snapshot consumed by the detector. `tornFraction` is the fraction
 * (0–1) of strikes on the displayed naive slice whose absolute IV miss
 * exceeds the "torn" threshold (computed upstream via `computeMisses`).
 */
export interface EventSnapshot {
  readonly shockActive: boolean;
  readonly tornFraction: number;
  /**
   * Naive panel's structural lag — the gap between the displayed
   * input view and the displayed fit, in feed ticks. Computed in
   * `App.tsx` via `computeSnapshotLag("naive", ...)` (see
   * `demo/src/metrics.ts` for the per-mode formula and the
   * post-fix rationale). Pairs with `tornFraction` for TearRecovery:
   * low `tornFraction` alone can be a fluke (the OU walk happened
   * to drift back near where the lagging fit was made — chart looks
   * clean by accident), so recovery also requires the structural
   * lag to have actually drained.
   */
  readonly naiveLagTicks: number;
  readonly pendingCount: number;
  readonly surfaceArbStatus: SurfaceArbStatus;
  readonly repairMode: "on" | "off";
  readonly tickHz: number;
  readonly expiries: number;
  readonly displayMaturityYears: number;
}

/**
 * Discriminant string. Exported so the scheduler can key cooldown /
 * phrase-routing logic without restringing.
 */
export type CommentaryEventType =
  | "ShockStart"
  | "ShockEnd"
  | "TearStart"
  | "TearRecovery"
  | "QueueSaturated"
  | "RepairFailed"
  | "IntentToggle"
  | "ControlChanged";

/**
 * Discriminated union of detector events. Each variant pins its `tier`
 * as a literal so TypeScript narrowing returns the tier without a
 * lookup table. `timestamp` is the `nowMs` at detection; the scheduler
 * uses it for FIFO ordering within a bucket.
 */
export type CommentaryEvent =
  | {
      readonly type: "ShockStart";
      readonly tier: 1;
      readonly timestamp: number;
    }
  | { readonly type: "ShockEnd"; readonly tier: 2; readonly timestamp: number }
  | {
      readonly type: "TearStart";
      readonly tier: 1;
      readonly timestamp: number;
      readonly tornFraction: number;
    }
  | {
      readonly type: "TearRecovery";
      readonly tier: 2;
      readonly timestamp: number;
      readonly tornFraction: number;
    }
  | {
      readonly type: "QueueSaturated";
      readonly tier: 1;
      readonly timestamp: number;
      readonly pendingCount: number;
    }
  | {
      readonly type: "RepairFailed";
      readonly tier: 1;
      readonly timestamp: number;
    }
  | {
      readonly type: "IntentToggle";
      readonly tier: 3;
      readonly timestamp: number;
      readonly value: "on" | "off";
    }
  | {
      readonly type: "ControlChanged";
      readonly tier: 4;
      readonly timestamp: number;
      readonly control: ControlId;
      readonly value: number;
    };

export interface EventDetector {
  /**
   * Feed the next snapshot at wall-clock `nowMs`. Returns events fired
   * by this transition (possibly empty).
   *
   * Output ordered by tier ascending, ties alphabetical — convention
   * only, not contract; the scheduler resorts by its own rules.
   *
   * Callers MUST invoke `update` regularly even when no app-state
   * change has occurred. Sustained-threshold buffers need ticks to
   * mature; `prev` needs ticks to roll forward.
   */
  update(snapshot: EventSnapshot, nowMs: number): readonly CommentaryEvent[];
}

/**
 * `tornFraction` value (inclusive) at and above which the surface
 * counts as torn — feeds the `TearStart` sustained-threshold buffer.
 * Tunable if real-time playthrough shows it's wrong.
 */
export const TEAR_START_THRESHOLD = 0.1;

/**
 * `tornFraction` value (inclusive) at and below which the surface
 * counts as recovered — feeds the `TearRecovery` mirror buffer. The
 * gap `(TEAR_RECOVERY_THRESHOLD, TEAR_START_THRESHOLD)` is the
 * "neutral zone" where neither side fires.
 */
export const TEAR_RECOVERY_THRESHOLD = 0.03;

/**
 * Sustained-buffer duration in ms — `tornFraction` must remain at /
 * above the threshold for this long before `TearStart` fires (mirror
 * for recovery). Single-dip below resets the buffer per the strict
 * semantics in design contract §4.
 */
export const TEAR_SUSTAINED_MS = 3_000;

/**
 * Naive's structural lag (`abs(latestInputs.tickIndex -
 * data.sourceTickIndex)`) must be at / below this value for
 * `TearRecovery` to fire. Pairs with `TEAR_RECOVERY_THRESHOLD` —
 * `tornFraction` alone is a derived signal that can dip low while
 * the lag is structurally still elevated (the OU walk happened to
 * drift back near where the lagging fit was made — chart looks
 * clean by accident). Requiring the lag to have actually drained
 * suppresses that fluke.
 *
 * Calibrated to `10` to match the post-fix structural floor at
 * Scenario 0 (lag fluctuates 1–9 ticks from the 5 Hz throttle on
 * feed.tick + eager setData on worker results) and to align with
 * `LAG_STALE_ENTER_TICKS = 10` in `Panel.tsx`. Pre-fix this was
 * `2`, calibrated against the OLD `max(0, currentTickIndex -
 * data.sourceTickIndex)` formula which clamped to 0 at light load
 * — that threshold made TearRecovery rarely fire post-fix because
 * the structural floor sits above the old threshold. See
 * `DEMO_METRIC_FIX_PLAN.md` Phase 2 + 4 for the full rationale.
 */
export const NAIVE_LAG_RECOVERY_THRESHOLD = 10;

/**
 * `pendingCount` value (inclusive) at and above which the worker
 * queue counts as saturated. Rising-edge detection: fires once on
 * crossing from `<` to `>=` this value. The demo's
 * `MAX_PENDING_QUEUE = 20` cap in `use-naive-fit.ts` means
 * `pendingCount ∈ [0, 20]`, so the threshold equals the cap.
 */
export const QUEUE_SATURATION_THRESHOLD = 20;

/**
 * Cooldown windows in ms — minimum spacing between consecutive
 * emissions of the same event type. `ControlChanged` uses its own
 * value but is keyed per-control id internally (see design contract
 * §5). Tunable during playthrough polish if pacing feels wrong.
 */
export const COOLDOWN_MS: Readonly<Record<CommentaryEventType, number>> = {
  ShockStart: 10_000,
  ShockEnd: 10_000,
  TearStart: 5_000,
  TearRecovery: 5_000,
  QueueSaturated: 8_000,
  RepairFailed: 10_000,
  IntentToggle: 1_000,
  ControlChanged: 1_000,
};

/**
 * Factory for an `EventDetector`. Each instance owns its own closure
 * state (prev snapshot, tear candidates + fired flags, cooldown maps).
 * Cheap to construct — a handful of variables, no listeners or
 * timers. Caller creates a fresh detector per session (no reset
 * method by design).
 */
export function createEventDetector(): EventDetector {
  // Closure state — see design contract §1, §2, §5, §15 for the full
  // shape rationale.

  // §1 — prev snapshot for edge detection. Null until bootstrap.
  let prev: EventSnapshot | null = null;

  // §2 — sustained-threshold state for TearStart / TearRecovery.
  // `*SinceMs` is the wall-clock the candidate first crossed the
  // threshold; `*Fired` is the "we already narrated this period"
  // flag that clears only when we drop back out of the target range
  // (full edge-of-state semantics on top of sustained-threshold
  // detection — see design contract §2 + §3).
  let tearStartSinceMs: number | null = null;
  let tearRecoverySinceMs: number | null = null;
  let tearStartFired = false;
  let tearRecoveryFired = false;
  // Tracks whether a `TearStart` has fired and not yet been matched by
  // a `TearRecovery`. Recovery emits only when this is true — without
  // a prior tear there's nothing to "recover from"; firing recovery
  // off a momentary `tornFraction` dip would be a fluke (see
  // `NAIVE_LAG_RECOVERY_THRESHOLD` doc).
  let recoveryPending = false;

  // §5 — cooldown maps. Per-type for most events; per-control for
  // ControlChanged (tickHz / expiries / displayMaturityYears get
  // independent cooldowns so rapid multi-control changes all fire).
  // The `?? -Infinity` default in lookup gives the first-emission case
  // a clean "infinitely-old timestamp" without an explicit "first
  // call" branch.
  const cooldowns = new Map<CommentaryEventType, number>();
  const controlCooldowns = new Map<ControlId, number>();

  /**
   * §7 — cooldown gates emission only. Returns true if `nowMs` is
   * past the cooldown window for `type` (or, for ControlChanged, for
   * the given `control` id).
   */
  function canEmit(
    type: CommentaryEventType,
    nowMs: number,
    control?: ControlId,
  ): boolean {
    const lastFiredMs =
      control !== undefined
        ? (controlCooldowns.get(control) ?? Number.NEGATIVE_INFINITY)
        : (cooldowns.get(type) ?? Number.NEGATIVE_INFINITY);
    return nowMs - lastFiredMs >= COOLDOWN_MS[type];
  }

  /**
   * Record `nowMs` as the last-emission timestamp for cooldown
   * purposes. Called after a successful emission.
   */
  function recordEmission(
    type: CommentaryEventType,
    nowMs: number,
    control?: ControlId,
  ): void {
    if (control !== undefined) {
      controlCooldowns.set(control, nowMs);
    } else {
      cooldowns.set(type, nowMs);
    }
  }

  return {
    update(snapshot, nowMs) {
      // §6 — bootstrap: first call returns []; only effect is storing
      // prev. Sustained-threshold candidates DO prime on bootstrap (so
      // a held-torn surface fires `TearStart` exactly
      // `TEAR_SUSTAINED_MS` later), but emission is suppressed by the
      // bootstrap early-return regardless.
      if (prev === null) {
        prev = snapshot;
        if (snapshot.tornFraction >= TEAR_START_THRESHOLD) {
          tearStartSinceMs = nowMs;
        }
        if (snapshot.tornFraction <= TEAR_RECOVERY_THRESHOLD) {
          tearRecoverySinceMs = nowMs;
        }
        return [];
      }

      const events: CommentaryEvent[] = [];

      // §1 — edge-detected events. Each fires on the asymmetric
      // transition from "not in target state" to "in target state".
      // No fire on the inverse transition; no fire when held.

      if (!prev.shockActive && snapshot.shockActive) {
        if (canEmit("ShockStart", nowMs)) {
          events.push({ type: "ShockStart", tier: 1, timestamp: nowMs });
          recordEmission("ShockStart", nowMs);
        }
      }
      if (prev.shockActive && !snapshot.shockActive) {
        if (canEmit("ShockEnd", nowMs)) {
          events.push({ type: "ShockEnd", tier: 2, timestamp: nowMs });
          recordEmission("ShockEnd", nowMs);
        }
      }

      // §11 — `RepairFailed` is the only surfaceArbStatus event. The
      // other two transitions (arb-free → repair-applied, and either
      // back to arb-free) are silent by design.
      if (
        prev.surfaceArbStatus !== "repair-failed" &&
        snapshot.surfaceArbStatus === "repair-failed"
      ) {
        if (canEmit("RepairFailed", nowMs)) {
          events.push({ type: "RepairFailed", tier: 1, timestamp: nowMs });
          recordEmission("RepairFailed", nowMs);
        }
      }

      // Threshold-crossing edge: queue rising past saturation. Only
      // fires on rising-to-threshold; re-fire requires the count to
      // drop below first, then cross back up.
      if (
        prev.pendingCount < QUEUE_SATURATION_THRESHOLD &&
        snapshot.pendingCount >= QUEUE_SATURATION_THRESHOLD
      ) {
        if (canEmit("QueueSaturated", nowMs)) {
          events.push({
            type: "QueueSaturated",
            tier: 1,
            timestamp: nowMs,
            pendingCount: snapshot.pendingCount,
          });
          recordEmission("QueueSaturated", nowMs);
        }
      }

      // §9 — IntentToggle: `repairMode` change. Tier 3. Per-type
      // cooldown — a rapid off→on→off within 1 s narrates only the
      // first transition (debounce, not per-direction lockout).
      if (prev.repairMode !== snapshot.repairMode) {
        if (canEmit("IntentToggle", nowMs)) {
          events.push({
            type: "IntentToggle",
            tier: 3,
            timestamp: nowMs,
            value: snapshot.repairMode,
          });
          recordEmission("IntentToggle", nowMs);
        }
      }

      // §9 + §10 — ControlChanged: tickHz / expiries /
      // displayMaturityYears. Tier 4. `Number.isFinite` guard on both
      // sides — `NaN !== NaN` is `true` in JS, which would otherwise
      // emit a phantom event when both prev and snapshot fields are
      // NaN (defensive — out of design space, but cheap to guard).
      if (
        Number.isFinite(prev.tickHz) &&
        Number.isFinite(snapshot.tickHz) &&
        prev.tickHz !== snapshot.tickHz
      ) {
        if (canEmit("ControlChanged", nowMs, "tickHz")) {
          events.push({
            type: "ControlChanged",
            tier: 4,
            timestamp: nowMs,
            control: "tickHz",
            value: snapshot.tickHz,
          });
          recordEmission("ControlChanged", nowMs, "tickHz");
        }
      }
      if (
        Number.isFinite(prev.expiries) &&
        Number.isFinite(snapshot.expiries) &&
        prev.expiries !== snapshot.expiries
      ) {
        if (canEmit("ControlChanged", nowMs, "expiries")) {
          events.push({
            type: "ControlChanged",
            tier: 4,
            timestamp: nowMs,
            control: "expiries",
            value: snapshot.expiries,
          });
          recordEmission("ControlChanged", nowMs, "expiries");
        }
      }
      if (
        Number.isFinite(prev.displayMaturityYears) &&
        Number.isFinite(snapshot.displayMaturityYears) &&
        prev.displayMaturityYears !== snapshot.displayMaturityYears
      ) {
        if (canEmit("ControlChanged", nowMs, "displayMaturityYears")) {
          events.push({
            type: "ControlChanged",
            tier: 4,
            timestamp: nowMs,
            control: "displayMaturityYears",
            value: snapshot.displayMaturityYears,
          });
          recordEmission("ControlChanged", nowMs, "displayMaturityYears");
        }
      }

      // §2 + §3 — sustained-threshold events.
      //
      // TearStart detection:
      //   - Gate on `!tearStartFired` so a held-torn state fires once,
      //     not every TEAR_SUSTAINED_MS + cooldown.
      //   - If torn and not yet fired: prime candidate if null, then
      //     fire if buffer matured (≥ TEAR_SUSTAINED_MS elapsed).
      //   - On fire: set fired flag AND clear candidate (candidate is
      //     moot post-fire; the fired flag is the gate).
      //   - If NOT torn: clear both candidate and fired flag (rearm
      //     for the next torn episode).
      if (snapshot.tornFraction >= TEAR_START_THRESHOLD) {
        if (!tearStartFired) {
          if (tearStartSinceMs === null) {
            tearStartSinceMs = nowMs;
          }
          if (nowMs - tearStartSinceMs >= TEAR_SUSTAINED_MS) {
            // Detection completed — internal state advances regardless
            // of cooldown (§7). Cooldown gates only the emission.
            tearStartFired = true;
            tearStartSinceMs = null;
            // Arm recovery so a subsequent TearRecovery can fire.
            // Set on DETECTION, not on emission — a cooldown-suppressed
            // TearStart still counts as a real tearing period for
            // recovery-pairing purposes.
            recoveryPending = true;
            if (canEmit("TearStart", nowMs)) {
              events.push({
                type: "TearStart",
                tier: 1,
                timestamp: nowMs,
                tornFraction: snapshot.tornFraction,
              });
              recordEmission("TearStart", nowMs);
            }
          }
        }
      } else {
        // Out of the torn range — clear candidate AND fired flag
        // together. Belt-and-braces: candidate may already be null
        // (post-fire) but the brief-spike-without-fire case still
        // needs the explicit clear.
        tearStartSinceMs = null;
        tearStartFired = false;
      }

      // TearRecovery — mirror of TearStart, with two extra guards:
      //   (a) `recoveryPending` requires a prior TearStart had fired —
      //       no recovery to announce if no tear happened.
      //   (b) Naive's lag must be ≤ `NAIVE_LAG_RECOVERY_THRESHOLD` —
      //       a low `tornFraction` alone is a derived signal that can
      //       dip while naive is still architecturally behind (older
      //       fit happens to align with newer dots). Requiring lag to
      //       have actually drained suppresses that fluke.
      const recoveryConditionsMet =
        snapshot.tornFraction <= TEAR_RECOVERY_THRESHOLD &&
        snapshot.naiveLagTicks <= NAIVE_LAG_RECOVERY_THRESHOLD &&
        recoveryPending;
      if (recoveryConditionsMet) {
        if (!tearRecoveryFired) {
          if (tearRecoverySinceMs === null) {
            tearRecoverySinceMs = nowMs;
          }
          if (nowMs - tearRecoverySinceMs >= TEAR_SUSTAINED_MS) {
            tearRecoveryFired = true;
            tearRecoverySinceMs = null;
            // Pair complete — clear pending so the next tear→recovery
            // cycle starts fresh.
            recoveryPending = false;
            if (canEmit("TearRecovery", nowMs)) {
              events.push({
                type: "TearRecovery",
                tier: 2,
                timestamp: nowMs,
                tornFraction: snapshot.tornFraction,
              });
              recordEmission("TearRecovery", nowMs);
            }
          }
        }
      } else {
        // Conditions fell out — clear the candidate. Fired flag also
        // clears so the next valid recovery period can prime.
        tearRecoverySinceMs = null;
        tearRecoveryFired = false;
      }

      // Roll prev forward unconditionally — state advances on every
      // call (design contract §7, cooldown vs internal state).
      prev = snapshot;

      // Order tier-ascending, ties alphabetical. Convention only; the
      // scheduler resorts. Tests at this layer assert the order.
      events.sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
      });

      return events;
    },
  };
}
