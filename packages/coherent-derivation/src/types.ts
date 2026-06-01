// Public type surface. Adopters depend only on what this file (and the
// re-exports in `index.ts`) expose; companion modules are implementation.

// ─── Source — subscription-based input ───────────────────────────────────────

/**
 * Brand symbol that identifies a `Source<T>` at the type and runtime level.
 *
 * Public-exported so adopters writing custom Source adapters (e.g. wrapping
 * an RxJS Observable, MobX reaction, or Solid signal) can construct a valid
 * Source by attaching this brand. The symbol's `unique symbol` nature
 * prevents structural-shape spoofing: a plain object literal with `subscribe`
 * + `getSnapshot` methods does NOT satisfy `Source<T>` without the brand.
 */
export const SourceBrand: unique symbol = Symbol("oracaus-source-brand");

/**
 * Subscription-based input source. Mirrors the shape consumed by React's
 * `useSyncExternalStore` — pair of `subscribe` (notify-driven) and
 * `getSnapshot` (point-read).
 *
 * Use for high-rate streaming inputs (option-chain ticks, market-data feeds,
 * any input pushed at rate higher than the host component's natural render
 * cadence). The substrate's hook subscribes to the source once and pulls
 * values via `getSnapshot()` on each notify — the host's render rate is
 * decoupled from the input rate.
 *
 * For low-rate inputs (slider values, mode toggles), pass the value directly
 * to the hook's `streaming` / `intent` slot — the hook auto-wraps it into a
 * Source internally.
 *
 * **Error contract.** Both `subscribe` and `getSnapshot` MUST NOT throw. This
 * matches the convention adopted by `useSyncExternalStore`: errors in
 * source-side code are the adopter's responsibility. The library does not
 * wrap these calls defensively because wrapping would mask bugs without
 * preventing them.
 *
 * @example Adopter-constructed Source backed by an event emitter:
 * ```ts
 * import { SourceBrand, type Source } from "@oracaus/coherent-derivation";
 *
 * function emitterSource<T>(emitter: EventEmitter<T>, getCurrent: () => T): Source<T> {
 *   return {
 *     [SourceBrand]: true,
 *     subscribe: (listener) => {
 *       emitter.on("value", listener);
 *       return () => emitter.off("value", listener);
 *     },
 *     getSnapshot: getCurrent,
 *   };
 * }
 * ```
 *
 * For the common imperative-push pattern (subscribe to an upstream feed in
 * a `useEffect`, call `push()` per event), use `useCallbackSource` from this
 * package — no need to construct a Source by hand.
 */
export interface Source<T> {
  readonly [SourceBrand]: true;
  /**
   * Subscribe to value changes. The listener is called synchronously each
   * time a new value is pushed. Returns an unsubscribe function. Calling
   * unsubscribe is idempotent.
   */
  subscribe(listener: () => void): () => void;
  /**
   * Read the current value. Called by the hook on each subscribe and each
   * notify. Must be cheap (no I/O, no allocation if avoidable). Returns
   * whatever the source's current value is; before the first push, may
   * return `undefined` or a user-supplied initial value (see
   * `useCallbackSource`).
   */
  getSnapshot(): T;
}

/**
 * Type guard. Discriminates a user-provided Source from a plain value at
 * runtime. Adopters do not typically need to call this directly — the hook
 * does so internally.
 */
export function isSource<T>(input: T | Source<T>): input is Source<T> {
  return (
    input !== null &&
    typeof input === "object" &&
    SourceBrand in (input as object) &&
    (input as Source<T>)[SourceBrand] === true
  );
}

// ─── Hook options ────────────────────────────────────────────────────────────

/**
 * Compute function. Runs in a Web Worker. Must be:
 *   - Pure: no DOM access, no main-thread-only globals, no closures over
 *     React state.
 *   - Serialisable inputs / output (see type-parameter constraints).
 *   - Cancellable: respect `signal.aborted` to abort early when an intent
 *     input change cancels the in-flight compute.
 *
 * The first argument carries both input kinds nested under named properties
 * so the consumer cannot accidentally treat one as the other. Either property
 * is `undefined` if the corresponding option was not passed.
 *
 * The `signal` parameter is propagated via an `abort` message across the
 * worker boundary (`AbortSignal` is not natively transferable through
 * `postMessage`). Adopter code uses it like a normal `AbortSignal`.
 */
export type ComputeFn<TStreaming, TIntent, TOutput> = (
  inputs: { streaming: TStreaming; intent: TIntent },
  signal: AbortSignal,
) => Promise<TOutput>;

/**
 * Fields shared by both option shapes.
 *
 * Both `TStreaming` and `TIntent` (and `TOutput`) must be serialisable via
 * `structuredClone` for transfer across the worker boundary. Class instances,
 * functions, Maps with non-string keys, etc. will fail at runtime when posted.
 *
 * Either `streaming` or `intent` is required (a hook with neither has nothing
 * to compute against). Mixed UIs — the common case — declare both.
 */
interface CoherentDerivationBaseOptions<TStreaming, TIntent> {
  /**
   * Current streaming inputs. Accepts EITHER a raw value or a
   * `Source<TStreaming>` (subscription-based — see `useCallbackSource`).
   *
   * - **Value form**: identity changes (compared by reference) flow through
   *   into the strategy. Adopters using object literals must memoise to
   *   avoid recompute-on-every-render — standard React idiom.
   * - **Source form**: high-rate streaming feeds plug in via
   *   `useCallbackSource` (or any adopter-constructed `Source<T>`). The
   *   substrate subscribes once and consumes via the source's push events;
   *   host component re-render rate is decoupled from input rate. The
   *   architecturally-recommended form for streaming-input use cases.
   *
   * Either way, identity changes absorb (do not cancel the in-flight
   * compute); the in-flight completes against its tagged snapshot, then
   * the next compute starts against whichever streaming value is current
   * at completion.
   *
   * Optional. Pure-intent UIs (a slider against a static dataset) can
   * omit it.
   */
  readonly streaming?: TStreaming | Source<TStreaming>;

  /**
   * Current intent inputs. Accepts EITHER a raw value or a
   * `Source<TIntent>` (subscription-based — see `useCallbackSource`).
   *
   * Either way, identity changes cancel the in-flight compute and restart
   * against the new value. The previously committed `data` remains visible
   * until the new compute lands.
   *
   * Adopters using object literals must memoise to avoid
   * recompute-on-every-render.
   *
   * Optional. Pure-streaming UIs (a vol-surface fitter against a chain
   * with no user-tunable parameters) can omit it.
   */
  readonly intent?: TIntent | Source<TIntent>;
}

/**
 * Configuration for a `useCoherentDerivation` instance.
 *
 * Type parameters:
 *   `TStreaming` — shape of the streaming inputs. Identity changes do not
 *                  cancel in-flight compute; the in-flight compute completes
 *                  against its tagged snapshot, then the next compute starts
 *                  against whichever streaming value is current at completion.
 *                  Use for option-chain ticks, position updates, market-data
 *                  feeds — upstream-cadence inputs whose new values are
 *                  additive rather than replacing.
 *
 *   `TIntent`    — shape of the intent inputs. Identity changes cancel the
 *                  in-flight compute and restart against the newest value.
 *                  Use for slider drags, parameter tweaks, mode selections —
 *                  user-driven inputs whose new values supersede the older
 *                  ones and invalidate any compute still running against
 *                  them.
 *
 *   `TOutput`    — shape of the compute's result.
 *
 * Exactly one of two shapes is required:
 *   - **Inline compute** — pass `compute` (the function travels to the
 *     library's inlined worker as a `.toString()` source string and is
 *     reconstructed via `new Function`). Self-contained computes only —
 *     module imports, runtime-loaded modules, and closures over React state
 *     are not supported through this path. `workerFactory` may also be
 *     supplied to override the worker construction (e.g. to pre-instantiate
 *     for warm-start or to choose a specific worker bundle).
 *   - **Bundled worker** — pass `workerFactory` returning a `Worker` that
 *     bundles the compute directly, typically via the W3C-standard
 *     `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`
 *     pattern (supported natively by Vite, Webpack 5+, Rollup, Parcel 2+,
 *     and esbuild). The worker listens for `WorkerInbound` messages and
 *     dispatches to its own bundled compute; the hook's `compute` option
 *     is unnecessary because the function never crosses the worker
 *     boundary. Use this for substantive compute that imports modules
 *     (LM solvers, ML inference pipelines, domain-specific fitters).
 *
 * `TOutput` is supplied via the generic parameter regardless of which shape
 * is used — pass explicit generics on the hook call when omitting `compute`.
 */
export type UseCoherentDerivationOptions<
  TStreaming = undefined,
  TIntent = undefined,
  TOutput = unknown,
> = CoherentDerivationBaseOptions<TStreaming, TIntent> &
  (
    | {
        readonly compute: ComputeFn<TStreaming, TIntent, TOutput>;
        readonly workerFactory?: () => Worker;
      }
    | {
        readonly compute?: ComputeFn<TStreaming, TIntent, TOutput>;
        readonly workerFactory: () => Worker;
      }
  );

// ─── Hook result ─────────────────────────────────────────────────────────────

/**
 * The reactive state surface exposed to the React component tree.
 *
 * Identity guarantee: when `data` is defined, it was computed against the
 * input snapshot identified by `dataSnapshotId`. The pair is composed
 * atomically — there is no rendered frame in which `data` from snapshot N is
 * paired with `streaming` or `intent` from a later snapshot.
 *
 * Strict-mode behaviour: in development under React's Strict Mode, the hook
 * mounts twice (mount → unmount → remount). The library handles this
 * correctly: each mount cycle terminates its own worker; no duplicate computes,
 * no leaked workers.
 *
 * SSR behaviour: under `useSyncExternalStore`'s `getServerSnapshot` path,
 * `data` is `undefined`, `isComputing` is `false`, and both snapshot IDs are
 * `undefined`. Hydration starts compute on the client side at first effect.
 */
export interface CoherentDerivationResult<TOutput> {
  /**
   * The most recent compute result whose input snapshot has been committed.
   * `undefined` until the first compute completes (or after a `cancel()` that
   * has not yet been followed by a fresh compute landing).
   *
   * When `data` is defined, it composes coherently with `dataSnapshotId`: the
   * `(streaming, intent)` pair the consumer was holding at `dataSnapshotId`
   * produced this output.
   */
  readonly data: TOutput | undefined;

  /**
   * `true` when a compute is currently in flight against the most recent
   * input snapshot. Use to drive loading UI when the consumer wants to signal
   * that fresh data is on the way.
   *
   * Distinct from `data === undefined`: a hook that has never computed and a
   * hook that is mid-recompute both can have `isComputing: true`, but only
   * the latter has a defined `data`.
   */
  readonly isComputing: boolean;

  /**
   * Identity tag for the input snapshot `data` was computed against.
   * `undefined` while `data` is `undefined`. Stable across rerenders: equal
   * `dataSnapshotId` means the same logical compute output, even if the
   * consumer's current `streaming` / `intent` object identities have changed.
   */
  readonly dataSnapshotId: string | undefined;

  /**
   * Identity tag for the input snapshot the in-flight compute is running
   * against, if any. `undefined` when `isComputing` is `false`. Used by the
   * library internally for cancellation-race correctness; exposed publicly
   * for adopters debugging substrate behaviour.
   */
  readonly computingSnapshotId: string | undefined;

  /**
   * The most recent error from the compute function, if any. Reset to
   * `undefined` when a subsequent compute starts. Adopter consumes via
   * conditional rendering or routes to a React error boundary.
   *
   * Errors from the compute are reconstructed across the worker boundary:
   * native `Error` properties (`name`, `message`, `stack`) survive
   * `structuredClone`; custom error subclasses lose their prototype identity
   * (this is a `postMessage` limitation, not specific to this library).
   */
  readonly error: unknown;

  /**
   * Force-cancel the in-flight compute. Terminates the worker and clears
   * `computingSnapshotId`. Visible `data` remains its last coherent value;
   * never partially.
   *
   * Intent input changes already cancel-and-restart automatically, so the
   * common reason to call `cancel()` manually is wiring an explicit "Stop"
   * affordance for the user.
   *
   * **Do not call `cancel()` from render.** It commits state synchronously
   * and notifies subscribers, which React surfaces as a setState-in-render
   * warning. Call from an event handler (e.g. a "Stop" button) or from a
   * `useEffect`.
   */
  readonly cancel: () => void;
}

// ─── Hook signature ──────────────────────────────────────────────────────────

/**
 * Run an async derivation in a Web Worker with coherence guarantees.
 *
 * Inputs are split into two named kinds — `streaming` and `intent`. The
 * substrate cancels the in-flight compute on intent change and absorbs on
 * streaming change. Either or both can be supplied; mixed UIs are first-class.
 *
 * @example Pure streaming (vol surface against streaming chain):
 * ```ts
 * const { data, isComputing } = useCoherentDerivation({
 *   streaming: { chain },
 *   compute: async ({ streaming }, signal) => fitVolSurface(streaming.chain, signal),
 * });
 * ```
 *
 * @example Pure intent (parameter slider against a static dataset):
 * ```ts
 * const { data, isComputing, cancel } = useCoherentDerivation({
 *   intent: { dataset, sliderValue },
 *   compute: async ({ intent }, signal) => aggregate(intent.dataset, intent.sliderValue, signal),
 * });
 * ```
 *
 * @example Mixed (vol surface against streaming chain plus user-controlled fit parameters):
 * ```ts
 * const { data, isComputing } = useCoherentDerivation({
 *   streaming: { chain },
 *   intent: { smoothing, fitMode },
 *   compute: async ({ streaming, intent }, signal) =>
 *     fitVolSurface(streaming.chain, intent.smoothing, intent.fitMode, signal),
 * });
 * ```
 *
 * @example Bundled worker (substantive compute with module imports):
 * ```ts
 * const { data } = useCoherentDerivation<{ chain: OptionChain }, undefined, FittedSurface>({
 *   streaming: { chain },
 *   workerFactory: () => new Worker(new URL("./svi-worker.ts", import.meta.url), { type: "module" }),
 * });
 * ```
 */
export type UseCoherentDerivation = <TStreaming, TIntent, TOutput>(
  options: UseCoherentDerivationOptions<TStreaming, TIntent, TOutput>,
) => CoherentDerivationResult<TOutput>;
