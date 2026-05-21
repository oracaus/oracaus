// Plays a list of phrases in order with inter-phrase gaps and
// cooperative cancellation. Wall-clock sleeps; no audio adapter.
//
// Cancellation: callers pass a mutable `CancelToken`. The sequencer
// reads it at three points per phrase — before setting the utterance,
// after the reading sleep, after the gap — so cancellation is
// observable at each natural boundary.
//
// Reading-time pacing: ~140 wpm, floored at 800 ms.

import type { CommentaryUtterance } from "../components/CommentaryToast.js";

export interface PhraseSpec {
  readonly id: string;
  readonly text: string;
  readonly tier: 1 | 2 | 3 | 4 | 5;
  /** Milliseconds to wait after this phrase before the next one. */
  readonly gapAfterMs: number;
}

export interface CancelToken {
  cancelled: boolean;
}

/** `ok` = all phrases completed; `cancelled` = token tripped at a check point. */
export type SequenceOutcome = "ok" | "cancelled";

// `setTimeout` so vitest's fake timers can advance it.
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** ~140 wpm, floored at 800 ms. */
export function estimateReadingMs(text: string): number {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  return Math.max(800, Math.round((words * 60_000) / 140));
}

/**
 * Convert a phrase spec into the surface's utterance payload.
 */
function toUtterance(phrase: PhraseSpec): CommentaryUtterance {
  return { id: phrase.id, text: phrase.text, tier: phrase.tier };
}

export interface RunPhraseSequenceOptions {
  readonly token: CancelToken;
  readonly setUtterance: (u: CommentaryUtterance | null) => void;
}

/**
 * Run a sequence of phrases. Returns when all phrases complete or when
 * the token is tripped. The caller is responsible for setting the
 * `CancelToken` to abort mid-sequence.
 */
export async function runPhraseSequence(
  phrases: readonly PhraseSpec[],
  options: RunPhraseSequenceOptions,
): Promise<SequenceOutcome> {
  const { token, setUtterance } = options;

  for (const phrase of phrases) {
    if (token.cancelled) return "cancelled";

    setUtterance(toUtterance(phrase));
    await sleep(estimateReadingMs(phrase.text));

    if (token.cancelled) return "cancelled";

    // Hook's `pushToast` treats `null` as no-op — the prior toast
    // continues its auto-dismiss through the gap.
    if (phrase.gapAfterMs > 0) {
      setUtterance(null);
      await sleep(phrase.gapAfterMs);
    }

    if (token.cancelled) return "cancelled";
  }

  return "ok";
}
