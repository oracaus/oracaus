// Helper runners for FakeWorker. The library's `defaultEchoRunner` echoes
// the full `{ streaming, intent }` envelope back; most strategy unit tests
// were written before the input-typed refactor and assert against the raw
// streaming value. These helpers extract the relevant slot so the migration
// from the old two-strategy API to the single `CoherentDerivationStrategy`
// preserves assertion shape — the test's intent (data preservation, listener
// race, etc.) is independent of which slot the value rides in.

import type { ComputeRunner } from "../../src/internal/worker-loop.js";

/** Extracts `streaming` from the envelope and returns it after a microtask. */
export const streamingEchoRunner: ComputeRunner = async (inputs) => {
  await Promise.resolve();
  return (inputs as { streaming: unknown }).streaming;
};

/** Extracts `intent` from the envelope and returns it after a microtask. */
export const intentEchoRunner: ComputeRunner = async (inputs) => {
  await Promise.resolve();
  return (inputs as { intent: unknown }).intent;
};
