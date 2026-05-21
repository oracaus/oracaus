// React hook entry-point. Two architectural choices the rest of this file
// implements:
//
// 1. **Two-layer state split** — `StrategyHandle` (stable per component,
//    owns the subscriber set) + `CoherentDerivationStrategy` (recreated on
//    every effect setup, owns the worker). The handle's stability lets
//    React's Strict Mode tear down and rebuild the strategy without losing
//    the subscription identity `useSyncExternalStore` depends on.
//
// 2. **Subscription-based input ingestion** — adopter inputs (`streaming`,
//    `intent`) accept either a raw value or a `Source<T>`. The hook
//    auto-wraps values into a synthetic source internally; high-rate
//    streaming feeds plug in via `useCallbackSource` (or any
//    adopter-constructed `Source<T>`). Strategy is fed via per-source
//    `useEffect` subscriptions — host re-render rate is decoupled from
//    input rate, which matters under streaming-input load (the substrate's
//    target use case). See `useInputAsSource` and the two subscription
//    effects in `useCoherentDerivation`.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CoherentDerivationStrategy } from "./internal/strategies/derivation-strategy.js";
import {
  makeInitialState,
  type StrategyState,
} from "./internal/strategies/strategy-state.js";
import { spawnWorker } from "./internal/worker-bootstrap.js";
import type { WorkerLike } from "./internal/worker-bridge.js";
import {
  type CoherentDerivationResult,
  isSource,
  type Source,
  SourceBrand,
  type UseCoherentDerivationOptions,
} from "./types.js";

interface Strategy<TStreaming, TIntent, TOutput> {
  getState(): StrategyState<TOutput>;
  subscribe(listener: () => void): () => void;
  setInputs(
    streaming: TStreaming,
    intent: TIntent,
    source: string | undefined,
  ): void;
  cancel(): void;
  destroy(): void;
}

function createStrategy<TStreaming, TIntent, TOutput>(
  options: UseCoherentDerivationOptions<TStreaming, TIntent, TOutput>,
): Strategy<TStreaming, TIntent, TOutput> {
  const worker: WorkerLike = options.workerFactory
    ? options.workerFactory()
    : spawnWorker();
  return new CoherentDerivationStrategy<TStreaming, TIntent, TOutput>(worker);
}

class StrategyHandle<TStreaming, TIntent, TOutput> {
  // Per-handle initial-state reference. Used both as the starting snapshot
  // and as the reset target on detach, so the equality check in `detach`
  // remains a single identity comparison even though `makeInitialState`
  // produces a fresh object each call.
  private readonly initial: StrategyState<TOutput> =
    makeInitialState<TOutput>();
  private strategy: Strategy<TStreaming, TIntent, TOutput> | null = null;
  private strategyUnsub: (() => void) | null = null;
  private state: StrategyState<TOutput> = this.initial;
  private readonly listeners = new Set<() => void>();

  attach(strategy: Strategy<TStreaming, TIntent, TOutput>): void {
    this.strategy = strategy;
    this.state = strategy.getState();
    this.strategyUnsub = strategy.subscribe(() => {
      const next = strategy.getState();
      if (next === this.state) return;
      this.state = next;
      this.notifyListeners();
    });
    this.notifyListeners();
  }

  detach(): void {
    this.strategyUnsub?.();
    this.strategyUnsub = null;
    this.strategy = null;
    if (this.state !== this.initial) {
      this.state = this.initial;
      this.notifyListeners();
    }
  }

  setInputs(
    streaming: TStreaming,
    intent: TIntent,
    source: string | undefined,
  ): void {
    this.strategy?.setInputs(streaming, intent, source);
  }

  // Bound at construction so `useSyncExternalStore` sees stable identities
  // across renders (otherwise it would resubscribe on every render).
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): StrategyState<TOutput> => this.state;

  readonly cancel = (): void => {
    this.strategy?.cancel();
  };

  private notifyListeners(): void {
    // Iterate a snapshot so a listener that unsubscribes itself or
    // another listener during this cycle doesn't perturb the delivery.
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

// ─── Input-source helpers (private) ──────────────────────────────────────────
//
// Adopter inputs to `useCoherentDerivation` accept either a raw value or a
// `Source<T>` (subscription-based — see `sources.ts`'s `useCallbackSource`).
// Internally the hook always operates on a Source. For value-based inputs
// we wrap into a synthetic source whose subscribers fire on `useEffect`-
// detected value-identity change. The public-facing API surface is the
// `Source<T>` interface and `useCallbackSource` helper; these helpers stay
// private.

/**
 * Constructs a stable per-hook-instance synthetic source backed by a local
 * listeners set. The returned `{source, push}` pair is identity-stable
 * across re-renders (built once via `useRef`).
 *
 * Used by `useInputAsSource` to wrap value-based adopter inputs. The
 * synthetic source's `subscribe` adds to the listeners set; `push`
 * updates the current value and notifies all listeners.
 *
 * The listener-iteration pattern uses a snapshot copy to allow mid-notify
 * subscriber modifications without perturbing the current delivery
 * (mirrors `StrategyHandle.notifyListeners`).
 */
function useStableSyntheticSource<T>(): {
  source: Source<T>;
  push: (v: T) => void;
} {
  const ref = useRef<{ source: Source<T>; push: (v: T) => void } | null>(null);
  if (ref.current === null) {
    const listeners = new Set<() => void>();
    let current: T | undefined;
    const source: Source<T> = {
      [SourceBrand]: true,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      // Pre-push, `current` is `undefined`; the caller's `T` type
      // parameter determines whether that's expressible. For the
      // typical adopter passing a defined value, the first push
      // happens in the wrapping useEffect's mount before any
      // subscriber reads — see `useInputAsSource` below.
      getSnapshot: () => current as T,
    };
    const push = (v: T): void => {
      current = v;
      for (const listener of [...listeners]) {
        listener();
      }
    };
    ref.current = { source, push };
  }
  return ref.current;
}

/**
 * Stabilises an adopter input (either a raw value or a `Source<T>`) into
 * a Source. User-provided Sources pass through unchanged; raw values get
 * wrapped into a synthetic source whose subscribers fire on value-
 * identity change.
 *
 * Returns `undefined` if the input is `undefined`, letting the caller
 * skip subscription entirely for unused input slots (pure-streaming UIs
 * that omit `intent`, etc.).
 */
function useInputAsSource<T>(
  input: T | Source<T> | undefined,
): Source<T> | undefined {
  const isUserSource = input !== undefined && isSource(input);
  const synthetic = useStableSyntheticSource<T>();

  // Push value changes into the synthetic source. Skipped when input is
  // a user Source (its own push mechanism delivers updates) or
  // undefined.
  useEffect(() => {
    if (input === undefined || isUserSource) return;
    synthetic.push(input as T);
  }, [input, isUserSource, synthetic]);

  if (input === undefined) return undefined;
  // `isSource` narrows the union; TS knows `input` is `Source<T>` here.
  if (isSource(input)) return input;
  return synthetic.source;
}

/**
 * Run an async derivation in a Web Worker with coherence guarantees.
 *
 * Public surface; the canonical adopter entry-point. See
 * {@link UseCoherentDerivationOptions} for the input contract and
 * {@link CoherentDerivationResult} for the reactive output shape and
 * identity guarantees.
 */
export function useCoherentDerivation<TStreaming, TIntent, TOutput>(
  options: UseCoherentDerivationOptions<TStreaming, TIntent, TOutput>,
): CoherentDerivationResult<TOutput> {
  // Type-level discriminated union already enforces "compute or workerFactory";
  // this runtime guard catches the case where adopters cast `as any` past the
  // type-check or construct the options dynamically.
  if (options.compute === undefined && options.workerFactory === undefined) {
    throw new TypeError(
      "useCoherentDerivation: pass `compute` (inline) or `workerFactory` " +
        "(bundled worker); see the README for the two patterns.",
    );
  }

  const [handle] = useState(
    () => new StrategyHandle<TStreaming, TIntent, TOutput>(),
  );

  // Strategy lifecycle: created on effect-setup, destroyed on cleanup; Strict
  // Mode safe because attach/detach are idempotent.
  //
  // Deps are intentionally `[handle]` only — the strategy is built from `options`
  // at effect-run time. Adding `options` to deps would tear down the worker on
  // every render. Mid-mount option changes therefore don't recreate the worker
  // (documented as a known limitation in the README).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    const strategy = createStrategy(options);
    handle.attach(strategy);
    return () => {
      handle.detach();
      strategy.destroy();
    };
  }, [handle]);

  // Dedup compute by source string when `compute` is provided. Two distinct
  // closures with identical bodies (e.g. inline arrow functions) toString() to
  // identical strings; the source is stable across renders even when compute
  // identity is not. `undefined` in the bundled-worker case — the custom worker
  // owns dispatch and never reconstructs from source.
  const source = useMemo(
    () =>
      options.compute === undefined ? undefined : options.compute.toString(),
    [options.compute],
  );

  // Stabilise streaming and intent inputs into Sources. Auto-wrap kicks
  // in when the adopter passes a value; a user-provided Source passes
  // through unchanged. See `useInputAsSource` above.
  const streamingSource = useInputAsSource(options.streaming);
  const intentSource = useInputAsSource(options.intent);

  // Cross-source refs. Each useEffect's listener reads the OTHER source
  // via its ref, so a ref-identity change to one source doesn't force
  // re-subscription of the other useEffect. Refs are written during
  // render and read during effects — by the time effects run, refs
  // reflect the committed render's source identities. This is the same
  // pattern the React community uses for "I need the latest X without
  // re-subscribing when X changes".
  const streamingSourceRef = useRef(streamingSource);
  streamingSourceRef.current = streamingSource;
  const intentSourceRef = useRef(intentSource);
  intentSourceRef.current = intentSource;

  // Source subscriptions. One useEffect per kind. The listener for each
  // source reads BOTH snapshots and calls handle.setInputs — strategy
  // compares per-kind and dispatches conflate-on-streaming or
  // cancel-on-intent as appropriate. Initial `update()` on mount pushes
  // the current snapshots into the strategy.
  //
  // Effect declaration order matters: streaming useEffect is declared
  // first, so when both inputs change in the same render batch the
  // streaming source's push fires first (via the push useEffect inside
  // useInputAsSource) and its listener calls setInputs with both new
  // snapshots — the strategy sees both changes and cancel-restarts
  // against (new streaming, new intent). The intent listener's
  // subsequent call is a no-op via the strategy's ref comparison.

  useEffect(() => {
    if (streamingSource === undefined) return;
    const captured = streamingSource;
    const update = (): void => {
      handle.setInputs(
        captured.getSnapshot(),
        intentSourceRef.current?.getSnapshot() as TIntent,
        source,
      );
    };
    update();
    return captured.subscribe(update);
  }, [streamingSource, source, handle]);

  useEffect(() => {
    if (intentSource === undefined) return;
    const captured = intentSource;
    const update = (): void => {
      handle.setInputs(
        streamingSourceRef.current?.getSnapshot() as TStreaming,
        captured.getSnapshot(),
        source,
      );
    };
    update();
    return captured.subscribe(update);
  }, [intentSource, source, handle]);

  const state = useSyncExternalStore(
    handle.subscribe,
    handle.getSnapshot,
    handle.getSnapshot,
  );

  // `handle.cancel` is bound at handle construction; the handle itself is
  // stable from `useState`, so the function reference is stable across
  // renders without `useCallback`.
  return {
    data: state.data,
    isComputing: state.isComputing,
    dataSnapshotId: state.dataSnapshotId,
    computingSnapshotId: state.computingSnapshotId,
    error: state.error,
    cancel: handle.cancel,
  };
}
