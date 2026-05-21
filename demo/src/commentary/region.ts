// Region tracking — pointer-aware narration substrate (Stage 11).
//
// `RegionId` is the closed enumeration of demo regions that can host an
// insight phrase. Hovering a region's root element sets the App's
// `hoveredRegion` state; the hook's debouncer (11.2) promotes a stable
// hover into a commit, which (11.6) enqueues a `region-insight` input
// after the polite-enqueue check.
//
// Regions match the demo's UI anatomy (PLAYBOOK §UI anatomy):
//
//   - `toolbar`          — top control bar (tick / expiries / slice / repair-mode)
//   - `naive-panel`      — top smile panel (NAIVE) including its metric ribbon
//   - `gated-panel`      — bottom smile panel (GATED) including its metric ribbon
//   - `chain-table`      — option-chain table (per-strike naive vs gated rows)
//   - `mismark-sparkline` — last-60 s mismark trace at the bottom of the rail
//
// Toolbar buttons, panel chip rails, and per-cell rows all resolve to
// their parent region via pointer-event bubbling — the region root is
// always the outermost element of each region. The cross-view hover
// overlay's per-strike pointer state (`hoveredK`) is orthogonal and
// lives independently.

export type RegionId =
  | "toolbar"
  | "naive-panel"
  | "gated-panel"
  | "chain-table"
  | "mismark-sparkline";

export const REGION_IDS: readonly RegionId[] = [
  "toolbar",
  "naive-panel",
  "gated-panel",
  "chain-table",
  "mismark-sparkline",
] as const;

// ---------------------------------------------------------------------
// Region settler — dwell debounce + exit grace (Stage 11.2)
// ---------------------------------------------------------------------
//
// Closure-stateful debouncer mirroring `createScenarioSettler`. Promotes
// a stable hover into a committed region after `REGION_DWELL_MS`; clears
// the commit after `REGION_EXIT_GRACE_MS` of being un-hovered. Caller
// drives via `update(hoveredRegion, nowMs)`; settler returns the current
// state. Commit-change detection is the caller's job (compare consecutive
// `committed` values).
//
// State machine (see COMMENTARY_PLAN.md Stage 11.2 for the full table):
//
//   - `enter(R)` where `R === committed` → cancel pending + exiting.
//   - `enter(R)` where `R !== committed` → cancel exiting; start (or
//     preserve) pending for R; promote to committed if dwell elapsed.
//   - `enter(Z)` while `pending = {Y, ...}` and `Z !== Y` → replace
//     pending with `{Z, t}` (fresh 1.5 s timer; no shared budget).
//   - `leave()` (hoveredRegion null) → cancel pending; if committed
//     non-null, start (or preserve) exiting; clear committed if exit
//     grace elapsed.
//   - `reset()` → clear all state. Caller invokes on phase-leave so
//     the next phase-enter doesn't see stale internal state.
//
// Backward-clock defence: timer-elapsed checks anchor `effectiveNow =
// max(nowMs, sinceMs)`. If the caller's clock regresses, the timer
// doesn't decrement.

export const REGION_DWELL_MS = 1_500;
export const REGION_EXIT_GRACE_MS = 500;

export interface RegionSettlerOutput {
  /** Currently-committed region; `null` if none. */
  readonly committed: RegionId | null;
  /** Region being dwelled toward (not yet committed); `null` if none. */
  readonly pending: RegionId | null;
  /** Exit grace timer is running (committed is non-null but pointer left). */
  readonly exiting: boolean;
}

interface PendingState {
  readonly region: RegionId;
  readonly sinceMs: number;
}

interface ExitingState {
  readonly sinceMs: number;
}

export interface RegionSettler {
  /**
   * Feed the current hover state + wall-clock time. Returns the
   * settler's current view. Caller compares consecutive `committed`
   * values to detect commit-changes.
   */
  update(hoveredRegion: RegionId | null, nowMs: number): RegionSettlerOutput;
  /**
   * Clear all state. Used on phase transitions out of OBSERVATION so
   * pre-existing pending / committed / exiting state doesn't leak
   * across phase boundaries.
   */
  reset(): RegionSettlerOutput;
}

export function createRegionSettler(): RegionSettler {
  let committed: RegionId | null = null;
  let pending: PendingState | null = null;
  let exiting: ExitingState | null = null;

  return {
    update(hoveredRegion, nowMs) {
      // Case 1: hover matches committed — user returned to (or stayed on)
      // the committed region. Cancel any pending or exiting timers.
      if (hoveredRegion !== null && hoveredRegion === committed) {
        pending = null;
        exiting = null;
        return { committed, pending: null, exiting: false };
      }

      // Case 2: hover is a different non-null region.
      if (hoveredRegion !== null) {
        // Hovering means not leaving.
        exiting = null;

        // Start (or preserve) pending for this region. Same-region
        // re-entry preserves `sinceMs` so the dwell timer keeps
        // accumulating across React re-renders.
        if (pending === null || pending.region !== hoveredRegion) {
          pending = { region: hoveredRegion, sinceMs: nowMs };
        }

        // Promote if dwell elapsed. Backward-clock-safe via max.
        const effectiveNow = Math.max(nowMs, pending.sinceMs);
        if (effectiveNow >= pending.sinceMs + REGION_DWELL_MS) {
          committed = pending.region;
          pending = null;
        }

        return {
          committed,
          pending: pending?.region ?? null,
          exiting: false,
        };
      }

      // Case 3: hover is null.
      pending = null;
      if (committed === null) {
        exiting = null;
        return { committed: null, pending: null, exiting: false };
      }

      // committed !== null and hover === null — exit grace.
      if (exiting === null) {
        exiting = { sinceMs: nowMs };
      }
      const effectiveNow = Math.max(nowMs, exiting.sinceMs);
      if (effectiveNow >= exiting.sinceMs + REGION_EXIT_GRACE_MS) {
        committed = null;
        exiting = null;
      }

      return {
        committed,
        pending: null,
        exiting: exiting !== null,
      };
    },

    reset() {
      committed = null;
      pending = null;
      exiting = null;
      return { committed: null, pending: null, exiting: false };
    },
  };
}
