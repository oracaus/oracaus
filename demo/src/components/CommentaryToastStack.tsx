// Bottom-centred stack of commentary toasts. Handles positioning + entry
// and exit animations; per-toast visuals are in `CommentaryToast`.
//
// Layout:
//
//   - Fixed at `bottom: 12 px`, centred horizontally.
//   - `items-center` on the flex column so each toast renders at its
//     intrinsic width (centred). Without it, older/shorter toasts
//     would stretch to match a wide sibling.
//   - Newest at bottom (closest to slide-source); older toasts get
//     pushed up via `gap-2` as new ones arrive.
//   - `pointer-events: none` so cursor tunnels through to the chart.
//
// Animations:
//
//   - Entry: each wrapper mounts at `opacity:0 + translateY(100%)` —
//     pushed BELOW its final position, off-screen downward. A
//     `useEffect` + `requestAnimationFrame` defers `setEntered(true)`
//     until after the browser paints the pre-entry frame; the CSS
//     transition then interpolates to `opacity:1 + translateY(0)` on
//     the compositor, sliding the toast UP into place. See the
//     `ToastEntry` body for the rationale — synchronous
//     `useLayoutEffect` would collapse both states into a single
//     paint and skip the transition.
//   - Exit: the hook marks `toast.leaving=true` when `dismissAtMs`
//     passes; the wrapper transitions to `opacity:0` (translateY
//     preserved — fade only, no slide). After `EXIT_ANIMATION_MS` the
//     hook drops the toast from the array.
//
// Capacity is enforced by the hook (max 2). This component just
// renders what's handed to it. Keeping the leaving lifecycle in the
// hook avoids a reconciliation race where the wrapper would unmount
// before the CSS transition could fire.

import { useEffect, useState } from "react";

import {
  CommentaryToast,
  type CommentaryToastInstance,
} from "./CommentaryToast.js";

export interface CommentaryToastStackProps {
  readonly toasts: readonly CommentaryToastInstance[];
}

// Minimal breathing room above the viewport edge — tight enough that
// the stack reads as peripheral rather than central, while not flush
// with the bottom (avoids the visually-clipped look that comes with
// 0px offset).
const STACK_BOTTOM_OFFSET_PX = 13;

// Two-frame entry. The toast mounts with `opacity:0 + translateY(100%)`,
// the browser paints that pre-entry frame, then a `requestAnimationFrame`
// callback flips `entered=true` for the next frame. The CSS transition
// then interpolates between the two painted frames.
//
// The previous useLayoutEffect-without-RAF approach committed both
// states (pre-entry and entered) to the DOM before the browser's first
// paint, so the browser treated the element's initial style as
// `opacity-100` and never ran the transition — the toast appeared to
// snap in. Exit still worked because by then the element had been
// painted for many frames, so the `leaving=true` style change
// triggered a clean transition.
function ToastEntry({
  toast,
}: {
  toast: CommentaryToastInstance;
}): React.ReactElement {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const leaving = toast.leaving === true;
  const transformClass = entered ? "translate-y-0" : "translate-y-full";
  const opacityClass = entered && !leaving ? "opacity-100" : "opacity-0";

  return (
    <div
      data-testid="commentary-toast-wrapper"
      data-leaving={leaving ? "true" : "false"}
      // Compositor-only properties: `opacity` (entry/exit fade) and
      // `transform` (entry slide-up via translateY). Explicit property
      // list keeps the transition off the main paint thread —
      // `transition-all` would have included colour, which nothing here
      // animates but which is paint-bound and would block in theory.
      // Easing is Material's "standard" curve (slight ease-in + ease-
      // out) — less front-loaded than the previous
      // cubic-bezier(.2,.8,.2,1) which collapsed most of the visible
      // change into the first 50 ms and read as abrupt.
      className={`transform-gpu transition-[opacity,transform] duration-250 ease-in-out ${transformClass} ${opacityClass}`}
    >
      <CommentaryToast toast={toast} />
    </div>
  );
}

export function CommentaryToastStack({
  toasts,
}: CommentaryToastStackProps): React.ReactElement | null {
  if (toasts.length === 0) return null;
  return (
    <div
      data-testid="commentary-toast-stack"
      // `items-center` is load-bearing — without it, older toasts
      // stretch to match the widest sibling.
      className="pointer-events-none fixed left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
      style={{ bottom: STACK_BOTTOM_OFFSET_PX }}
    >
      {toasts.map((toast) => (
        // Key is `instanceId`, not `id`. The phrase id is reused across
        // re-firings (cooldown / library identifier); two toasts may
        // share `id`. `instanceId` is per-push unique.
        <ToastEntry key={toast.instanceId} toast={toast} />
      ))}
    </div>
  );
}
