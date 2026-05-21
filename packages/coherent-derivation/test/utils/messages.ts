// Helpers for constructing wire messages in tests. `source` is optional on
// `ComputeRequest` (omitted for bundled-worker callers). Tests exercising
// message-flow plumbing with custom runners pick an empty default so tests
// stay focused on the fields they actually care about.

import type { SnapshotId } from "../../src/internal/snapshot-id.js";
import type { ComputeRequest } from "../../src/internal/worker-protocol.js";

export function computeRequest(
  id: SnapshotId,
  inputs: unknown,
  source: string | undefined = "",
): ComputeRequest {
  return source === undefined
    ? { type: "compute", id, inputs }
    : { type: "compute", id, inputs, source };
}
