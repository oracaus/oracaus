// Advanced trader-controls panel — Radix Dialog hosting creator-side
// configuration (seed override, recording-mode status). Not surfaced in
// the toolbar — this is for the author recording demos / forking runs,
// not for visitors landing on the demo. Triggered via `?` keyboard
// shortcut (App.tsx).
//
// Controlled mode: parent owns `open` state; `onOpenChange` fires when
// the user dismisses via Escape, overlay click, or the close button.
//
// Radix Dialog gives focus-trap, escape-to-close, accessible labelling
// for free. Style is neutral overlay + slate panel — no decorative
// shadows; one-pixel borders to match the rest of the desk-operator
// register.

import * as Dialog from "@radix-ui/react-dialog";
import { memo } from "react";

export type AdvancedControlsProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly seed: number;
  readonly recording: boolean;
  readonly onReseed: (seed: number) => void;
};

// Memoised. App re-renders at the feed-tick cadence (50–500 Hz);
// `AdvancedControls`'s props (`open`, `seed`, `recording`,
// callbacks-from-useState-setters) are all stable across those
// renders. When the modal is closed the Radix Dialog renders nothing
// in the DOM, so the cost was already small — but reconciling the
// Dialog.Root context provider 50× per second is wasted work in the
// hot path. Memo skips the reconciliation entirely when no props
// change.
function AdvancedControlsImpl(props: AdvancedControlsProps) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 w-md -translate-x-1/2 -translate-y-1/2 rounded border border-border bg-bg-elev p-5 shadow-2xl outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Title className="mb-1 font-sans text-sm font-semibold">
            advanced controls
          </Dialog.Title>
          <p className="mb-4 font-sans text-xs text-fg-muted">
            recording-mode and PRNG seed are derived from URL params on load (
            <code className="font-mono">?seed=</code>,{" "}
            <code className="font-mono">?mode=recording</code>). Use the seed
            input below to fork a new run without reloading.
          </p>

          <div className="space-y-3">
            <div className="grid grid-cols-[max-content_1fr] items-center gap-x-3">
              <label
                htmlFor="seed-input"
                className="font-mono text-xs uppercase tracking-wide text-fg-muted"
              >
                seed
              </label>
              <input
                id="seed-input"
                type="number"
                defaultValue={props.seed}
                onBlur={(e) => {
                  const next = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(next)) props.onReseed(next);
                }}
                className="rounded border border-border bg-bg px-2 py-1 font-mono text-xs"
              />
            </div>

            <div className="grid grid-cols-[max-content_1fr] items-center gap-x-3">
              <span className="font-mono text-xs uppercase tracking-wide text-fg-muted">
                recording
              </span>
              <span
                className={`font-mono text-xs ${
                  props.recording ? "text-accent-info" : "text-fg-muted"
                }`}
              >
                {props.recording ? "ON (URL-locked)" : "off"}
              </span>
            </div>
          </div>

          <div className="mt-5 flex justify-end">
            <Dialog.Close asChild>
              <button
                type="button"
                className="focus-ring rounded border border-border bg-bg px-3 py-1 font-mono text-xs text-fg-muted transition-colors duration-75 hover:text-fg"
              >
                close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const AdvancedControls = memo(AdvancedControlsImpl);
