// `SnapshotId` (public, exported via `index.ts`) and `SnapshotIssuer`
// (internal — the strategy's per-mount monotonic source). The type's
// adopter-facing contract is on the JSDoc below; this header just notes
// the split.

declare const SnapshotIdBrand: unique symbol;

/**
 * Identity tag for an input snapshot — the load-bearing correlation between
 * a `ComputeRequest` and its eventual `ResultResponse` / `ErrorResponse`.
 *
 * Branded opaque `string`: adopters writing custom workers (via
 * `workerFactory`) receive an id on `inbound.id` and echo it verbatim on the
 * matching outbound; they never construct values of this type themselves.
 * The brand is preserved for type-level safety on the main thread (the
 * library's strategy compares ids against its current in-flight tag to drop
 * stale responses) but is opaque to adopters — `SnapshotIssuer` is internal.
 *
 * Stable across the wire: the value survives `structuredClone` intact and
 * the worker treats it as an opaque string. Adopters that need to refer to
 * the type in their own helpers can import it from
 * `@oracaus/coherent-derivation`; that import is the canonical way to name
 * the id field on the published message types.
 */
export type SnapshotId = string & {
  readonly [SnapshotIdBrand]: typeof SnapshotIdBrand;
};

/**
 * Mints monotonically-increasing, per-issuer-unique `SnapshotId`s. Each
 * strategy state machine owns its own issuer so the counter scope is the
 * lifetime of a single hook mount; Strict Mode's double-mount produces two
 * issuers, both starting at 1 — the strategy is responsible for using only
 * the active one.
 */
export class SnapshotIssuer {
  // Monotonic positive integer. Loses precision and stops being unique
  // beyond `Number.MAX_SAFE_INTEGER` (2⁵³ − 1). A single strategy issuing
  // 1 M ids per second would take ~285 000 years to reach that bound, and
  // a strategy's lifetime is one hook mount — practically unreachable.
  // Noted explicitly so a future audit doesn't mistake the absence of an
  // overflow guard for an oversight.
  private counter = 0;
  private readonly prefix: string;

  constructor(prefix: string = "snap") {
    this.prefix = prefix;
  }

  next(): SnapshotId {
    this.counter += 1;
    return `${this.prefix}-${this.counter}` as SnapshotId;
  }
}
