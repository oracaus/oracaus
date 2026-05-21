// Internal state shape. Produced by the strategy and consumed by the React
// hook layer; mirrors `CoherentDerivationResult<TOutput>` from the public API
// minus `cancel()`, which the hook adds when wrapping the strategy in
// `useSyncExternalStore`.

import type { SnapshotId } from "../snapshot-id.js";

export interface StrategyState<TOutput> {
  readonly data: TOutput | undefined;
  readonly dataSnapshotId: SnapshotId | undefined;
  readonly computingSnapshotId: SnapshotId | undefined;
  readonly isComputing: boolean;
  readonly error: unknown;
}

/**
 * Fresh `StrategyState<TOutput>` with pristine values. The function form
 * (vs. a shared const) sidesteps the variance gymnastics of typing a
 * `StrategyState<never>` constant for assignment into a `StrategyState<TOutput>`
 * field.
 */
export function makeInitialState<TOutput>(): StrategyState<TOutput> {
  return {
    data: undefined,
    dataSnapshotId: undefined,
    computingSnapshotId: undefined,
    isComputing: false,
    error: undefined,
  };
}
