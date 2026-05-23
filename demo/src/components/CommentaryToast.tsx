// Per-toast visual: tier dot + tier-tinted background + multi-line
// text. Positioning + entry/exit animations live in
// `CommentaryToastStack`. Pure presentational — no lifecycle, no
// timers; the hook owns dismiss state via the `leaving` flag.
//
// `aria-hidden="true"` — visual-only surface. The demo's target
// audience is sighted users; fast-changing financial scaffolding text
// doesn't translate usefully to audio.
//
// Tier-tinted background is a redundant signal beyond the tier dot
// (a11y — don't lean on a single colour). 15 % alpha overlay on
// `bg-bg-elev/75`:
//
//   T1 critical    → red wash
//   T2 transition  → amber wash
//   T3 comparison  → blue wash
//   T4 observation → neutral
//   T5 idle        → neutral
//
// T4 / T5 stay neutral so typical-case toasts read as ambient; only
// narratively-loaded events get visual emphasis.
//
// T5 dot is a hollow ring (rest are filled) so "idle" reads as
// shape-distinct from "observation" at small dot size.
//
// Memoised — re-renders only when the toast list mutates.

import { memo } from "react";

/**
 * Tier — drives the dot colour + background tint.
 *
 *   1 critical    (shock, tear, repair-failed, queue-saturated)
 *   2 transition  (shock end, recovery)
 *   3 comparison  (naive vs. Oracaus)
 *   4 observation (chip values, settings ack)
 *   5 idle        (ambient filler)
 */
export type CommentaryTier = 1 | 2 | 3 | 4 | 5;

/** Narration payload handed to `pushToast`. */
export interface CommentaryUtterance {
  readonly id: string;
  readonly text: string;
  readonly tier: CommentaryTier;
}

export interface CommentaryToastInstance extends CommentaryUtterance {
  /**
   * Per-push unique React key. Distinct from `id` (phrase id) — the
   * phrase id is reused across re-firings (scheduler cooldown +
   * library identifier), so two toasts in the stack may share `id`.
   */
  readonly instanceId: string;
  /** Wall-clock-ms when the toast enters the leaving phase. */
  readonly dismissAtMs: number;
  /** Set by the hook's dismiss-tick once `dismissAtMs` passes. */
  readonly leaving?: boolean;
}

export interface CommentaryToastProps {
  readonly toast: CommentaryToastInstance;
}

// Per-tier dot styling. T1–T4 are filled in their tier colour; T5 is a
// hollow ring in the muted tone (distinct shape signals "idle" beyond
// just dimmer colour).
const TIER_DOT_CLASS: Record<CommentaryTier, string> = {
  1: "bg-accent-stale",
  2: "bg-accent-warn",
  3: "bg-accent-info",
  4: "bg-fg-muted",
  5: "border-2 border-fg-muted bg-transparent",
};

// Per-tier background-tint overlay. T1–T3 carry a tier accent wash at
// 15% alpha; T4 / T5 are neutral so ambient narration doesn't shout.
// Rendered as a separate absolutely-positioned `<span>` so it stacks
// cleanly on TOP of the toast's translucent slate base — Tailwind can't
// give a single element two background colours, so the layer split is
// load-bearing for the tier identity to be visible.
const TIER_TINT_CLASS: Record<CommentaryTier, string> = {
  1: "bg-accent-stale/15",
  2: "bg-accent-warn/15",
  3: "bg-accent-info/15",
  4: "",
  5: "",
};

function CommentaryToastImpl({
  toast,
}: CommentaryToastProps): React.ReactElement {
  const tintClass = TIER_TINT_CLASS[toast.tier];
  return (
    <div
      aria-hidden="true"
      data-testid="commentary-toast"
      data-tier={toast.tier}
      // Composition: base layer = `bg-bg-elev/75` + `backdrop-blur-md`
      // (translucent card over a 12 px blur of whatever's behind). The
      // underlying app stays slightly visible through the bg, then
      // sharpens via the blur. Tier tint paints as a separate absolutely-
      // positioned span (see below) — Tailwind can't give a single
      // element two background colours. The border + rounded edges +
      // shadow give the card a defined shape against the panels.
      className="relative flex max-w-160 items-start gap-3 overflow-hidden rounded border border-border bg-bg-elev/75 px-4 py-3 font-mono text-[13px] text-fg shadow-lg backdrop-blur-md"
    >
      {tintClass !== "" && (
        <span
          aria-hidden="true"
          data-testid="commentary-toast-tier-tint"
          className={`pointer-events-none absolute inset-0 ${tintClass}`}
        />
      )}
      {/* Dot wrapper height = text's line-height (leading-snug × font),
          with items-center centring the dot within. Pairs with the
          outer `items-start` so the dot lands on the first line of
          text regardless of how many lines the text wraps to. */}
      <span className="relative inline-flex h-[1.375em] shrink-0 items-center">
        <span
          aria-hidden="true"
          data-testid="commentary-toast-tier-dot"
          className={`size-2 rounded-full ${TIER_DOT_CLASS[toast.tier]}`}
        />
      </span>
      <span
        data-testid="commentary-toast-text"
        className="relative leading-snug"
      >
        {toast.text}
      </span>
    </div>
  );
}

export const CommentaryToast = memo(CommentaryToastImpl);
