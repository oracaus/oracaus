// Helper hooks for constructing `Source<T>` inputs to
// `useCoherentDerivation`. Two adopter-facing entry-points cover the
// common upstream shapes:
//
//   • `useEventSource` — declarative; bridges a subscribe-shaped feed
//     (`subscribe(cb) → unsubscribe`) into a `Source<T>` in one line.
//     The canonical pattern for high-rate streaming inputs.
//
//   • `useCallbackSource` — imperative; returns `[Source<T>, push]`.
//     Use when the value flows from event handlers, refs, or anywhere
//     the adopter has direct control over when to push.
//
// Adopters bridging more exotic upstreams (RxJS observables, Solid
// signals, MobX reactions) construct a `Source<T>` directly against the
// published interface — the `SourceBrand` is exported for that case.

import { useEffect, useRef } from "react";
import { type Source, SourceBrand } from "./types.js";

/**
 * Imperative source — returns a stable `[Source<T>, push]` tuple. Caller
 * imperatively pushes values from any context (event handler, callback
 * ref, manual button-click flow). The source notifies subscribers
 * synchronously on each push.
 *
 * **For high-rate subscribe-shaped feeds, prefer `useEventSource`** — it
 * captures the canonical `subscribe(cb) → unsubscribe` pattern in a
 * single call. `useCallbackSource` is for cases where adopter code
 * decides when to push rather than reacting to an event stream.
 *
 * The push function is referentially stable across renders — safe to
 * include in `useEffect` deps without causing re-subscription churn.
 *
 * **Initial-value semantics.** `getSnapshot()` returns the `initial`
 * argument (or `undefined` if omitted) until the first `push()` call.
 * After the first push, `getSnapshot()` returns the most recent pushed
 * value. Adopters whose substrate compute can't handle `undefined`
 * should pass an explicit initial — typically a placeholder value the
 * compute recognises as "no data yet".
 *
 * **Subscriber notification semantics.** Listeners fire synchronously
 * during `push()`. A snapshot of the listener set is iterated, so a
 * listener that unsubscribes itself (or another) mid-notify is safe:
 * it still fires for the current delivery and is absent on the next.
 * Adding a listener mid-notify means the new listener fires starting
 * from the next push.
 *
 * @example High-rate streaming feed:
 * ```ts
 * const [tickSource, pushTick] = useCallbackSource<Tick>();
 * useEffect(() => subscribeToFeed(pushTick), [pushTick]);
 *
 * const { data } = useCoherentDerivation({
 *   streaming: tickSource,
 *   workerFactory: () => new Worker(...),
 * });
 * ```
 *
 * @example With an explicit initial (placeholder pattern):
 * ```ts
 * const [tickSource, pushTick] = useCallbackSource<DataShape>(PLACEHOLDER);
 * // Substrate's first compute receives PLACEHOLDER until first real push.
 * ```
 */
export function useCallbackSource<T>(
  initial?: T,
): readonly [Source<T>, (value: T) => void] {
  // Build the source + push once via `useRef` so both retain stable
  // identity across re-renders. The host's `useEffect` deps array can
  // include `pushTick` safely without firing re-subscriptions on each
  // render.
  const ref = useRef<readonly [Source<T>, (value: T) => void] | null>(null);

  if (ref.current === null) {
    const listeners = new Set<() => void>();
    let current: T | undefined = initial;
    const source: Source<T> = {
      [SourceBrand]: true,
      subscribe: (listener) => {
        listeners.add(listener);
        // Unsubscribe is idempotent — Set.delete on a missing entry is a
        // no-op (and returns false, which we discard).
        return () => {
          listeners.delete(listener);
        };
      },
      // `current` may be `T` (post-push) or `undefined` (pre-push when
      // no initial supplied). The signature returns `T` because the
      // adopter chose the parameter — if they passed no initial, they
      // accept `undefined` until first push (TypeScript reflects this
      // via the caller's `T = SomeType | undefined`).
      getSnapshot: () => current as T,
    };
    const push = (value: T): void => {
      current = value;
      // Iterate a snapshot of the listener set. Self-unsubscribe and
      // other-unsubscribe mid-notify are safe (see notification
      // semantics in docstring above).
      for (const listener of [...listeners]) {
        listener();
      }
    };
    ref.current = [source, push] as const;
  }

  return ref.current;
}

/**
 * Bridge a subscribe-shaped upstream feed into a `Source<T>` consumable
 * by `useCoherentDerivation`. **The recommended adopter pattern for
 * high-rate streaming inputs** — market-data feeds, position updates,
 * event-emitter streams, WebSocket subscribers, server-sent events —
 * anything that exposes a `subscribe(callback) → unsubscribe` shape.
 *
 * Internally bridges the feed to a `Source<T>` using the same
 * subscribe/getSnapshot interface React's `useSyncExternalStore`
 * consumes. The substrate subscribes once and receives pushes through
 * the source — **the host component does not re-render per push.** That
 * is the load-bearing decoupling: at upstream cadence (say 500 ticks
 * per second), the host renders at substrate commit cadence (say 12 Hz)
 * rather than at input rate.
 *
 * **Initial-value semantics.** If `initial` is supplied, the substrate's
 * first compute fires against it immediately on mount. Otherwise the
 * substrate waits for the first push from the feed before its first
 * compute.
 *
 * **Subscribe identity.** `subscribe` is captured in a `useEffect`
 * dependency; an unstable subscribe identity (e.g. inline arrow that
 * closes over render-scope variables) will re-subscribe every render.
 * In practice `subscribe` is exported from a custom hook or a shared
 * module and is naturally stable; if not, wrap in `useCallback`.
 *
 * @example Vol-surface fit against a streaming chain feed:
 * ```ts
 * const chainSource = useEventSource(subscribeChain);
 *
 * const { data, isComputing } = useCoherentDerivation({
 *   streaming: chainSource,
 *   workerFactory: () => new VolSurfaceWorker(),
 * });
 * ```
 *
 * @example With an explicit initial value (placeholder pattern):
 * ```ts
 * const chainSource = useEventSource(subscribeChain, PLACEHOLDER_CHAIN);
 * // Substrate's first compute fires against PLACEHOLDER_CHAIN immediately;
 * // subsequent pushes deliver real chain ticks.
 * ```
 *
 * @example With an inline transformation:
 * ```ts
 * const surfaceSource = useEventSource<SurfaceInput>(
 *   (push) => subscribeChain((tick) => push({
 *     slices: tick.slices,
 *     tickIndex: tick.tickIndex,
 *   })),
 * );
 * ```
 */
export function useEventSource<T>(
  subscribe: (push: (value: T) => void) => () => void,
  initial?: T,
): Source<T> {
  const [source, push] = useCallbackSource<T>(initial);
  useEffect(() => subscribe(push), [subscribe, push]);
  return source;
}
