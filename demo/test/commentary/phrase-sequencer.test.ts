// Tests for the phrase sequencer primitive. Uses vitest fake timers to
// drive the wall-clock reading-time sleeps.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  estimateReadingMs,
  type PhraseSpec,
  runPhraseSequence,
} from "../../src/commentary/phrase-sequencer.js";
import type { CommentaryUtterance } from "../../src/components/CommentaryToast.js";

const PHRASES: readonly PhraseSpec[] = [
  { id: "p1", text: "First.", tier: 4, gapAfterMs: 500 },
  { id: "p2", text: "Second.", tier: 3, gapAfterMs: 500 },
  { id: "p3", text: "Third.", tier: 2, gapAfterMs: 0 },
];

describe("phrase sequencer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("estimateReadingMs floors at 800 ms for very short phrases", () => {
    expect(estimateReadingMs("Hi.")).toBe(800);
    // ~140 wpm → 429 ms per word; 10-word phrase ≈ 4286 ms.
    expect(
      estimateReadingMs("one two three four five six seven eight nine ten"),
    ).toBeGreaterThan(3000);
  });

  it("estimateReadingMs returns the 800 ms floor for empty input (no special-case shortcut)", () => {
    // The floor is unconditional — empty text is treated the same as
    // a single-word phrase. Callers don't pass empty text in practice.
    expect(estimateReadingMs("")).toBe(800);
    expect(estimateReadingMs("   ")).toBe(800);
  });

  it("advances by reading time per phrase, calling setUtterance for each", async () => {
    const setUtterance = vi.fn<(u: CommentaryUtterance | null) => void>();
    const token = { cancelled: false };

    const promise = runPhraseSequence(PHRASES, { token, setUtterance });

    // First phrase fires synchronously inside the sequencer body's
    // first iteration before any await.
    await vi.advanceTimersByTimeAsync(0);
    expect(setUtterance).toHaveBeenCalledWith({
      id: "p1",
      text: "First.",
      tier: 4,
    });

    // Drive enough virtual time to drain all three phrases + gaps.
    // Each single-word phrase has 800 ms reading time + 500 ms gap
    // (last has 0 gap). Total ≈ 800 + 500 + 800 + 500 + 800 = 3400 ms.
    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await promise;

    expect(outcome).toBe("ok");
    expect(setUtterance).toHaveBeenCalledWith({
      id: "p2",
      text: "Second.",
      tier: 3,
    });
    expect(setUtterance).toHaveBeenCalledWith({
      id: "p3",
      text: "Third.",
      tier: 2,
    });
  });

  it("inter-phrase gap fires setUtterance(null) between phrases when gapAfterMs > 0", async () => {
    const setUtterance = vi.fn<(u: CommentaryUtterance | null) => void>();
    const token = { cancelled: false };

    const promise = runPhraseSequence(PHRASES, { token, setUtterance });
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(setUtterance).toHaveBeenCalledWith(null);
  });

  it("cancellation via token bails immediately on the next check point", async () => {
    const setUtterance = vi.fn<(u: CommentaryUtterance | null) => void>();
    const token = { cancelled: false };

    const promise = runPhraseSequence(PHRASES, { token, setUtterance });
    await vi.advanceTimersByTimeAsync(0);
    // First phrase has fired. Flip token while first phrase's reading
    // sleep is in flight.
    token.cancelled = true;
    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await promise;

    expect(outcome).toBe("cancelled");
    // No second phrase pushed (cancel observed after first await).
    expect(setUtterance).not.toHaveBeenCalledWith({
      id: "p2",
      text: "Second.",
      tier: 3,
    });
  });

  it("cancellation BEFORE the first phrase fires bails with no setUtterance", async () => {
    const setUtterance = vi.fn<(u: CommentaryUtterance | null) => void>();
    const token = { cancelled: true };

    const promise = runPhraseSequence(PHRASES, { token, setUtterance });
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await promise;

    expect(outcome).toBe("cancelled");
    expect(setUtterance).not.toHaveBeenCalled();
  });

  it("empty phrase list resolves 'ok' immediately without setUtterance", async () => {
    const setUtterance = vi.fn<(u: CommentaryUtterance | null) => void>();
    const token = { cancelled: false };

    const promise = runPhraseSequence([], { token, setUtterance });
    const outcome = await promise;

    expect(outcome).toBe("ok");
    expect(setUtterance).not.toHaveBeenCalled();
  });
});
