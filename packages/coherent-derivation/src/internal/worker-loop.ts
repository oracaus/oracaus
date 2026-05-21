// Worker-side message dispatch and per-id compute lifecycle. Each `compute`
// request creates an `AbortController`; `abort` messages look up that
// controller and call `controller.abort()`. The signal is passed to the
// registered `ComputeRunner` (defaults to `productionRunner`, which
// reconstructs the user's compute via `new Function`; tests inject custom
// runners via the `WorkerLoop` constructor).

import { assertNever } from "./assert-never.js";
import { serializeError } from "./serialize-error.js";
import type { SnapshotId } from "./snapshot-id.js";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol.js";

/**
 * Turns `(inputs, signal, source)` into the compute output.
 *
 * - **Production** uses `productionRunner`, which reconstructs the user's
 *   compute function from its serialised source via `new Function(...)` and
 *   invokes it with the inputs and signal. CSP environments disallowing
 *   `Function` constructor supply a `workerFactory` with a worker that has
 *   the compute statically — custom workers don't use a `ComputeRunner` at
 *   all.
 * - **Tests** use `defaultEchoRunner` (or custom runners) to verify
 *   message-flow plumbing without depending on `Function` constructor.
 *
 * `source` is `undefined` when the hook was called with `workerFactory` and
 * no `compute`. The default `productionRunner` requires `source` and throws
 * a clear error otherwise; custom runners may interpret `undefined` however
 * they need.
 */
export type ComputeRunner = (
  inputs: unknown,
  signal: AbortSignal,
  source: string | undefined,
) => Promise<unknown>;

export type Reply = (response: WorkerOutbound) => void;

/**
 * Echoes inputs as output after a microtask yield. Ignores `source`. Used
 * by `FakeWorker` in tests so the message envelope can be verified without
 * the `Function` constructor path.
 */
export const defaultEchoRunner: ComputeRunner = async (
  inputs,
  _signal,
  _source,
) => {
  await Promise.resolve();
  return inputs;
};

type CompiledCompute = (i: unknown, s: AbortSignal) => unknown;

/**
 * Pre-flight check: bound functions, native functions, and host-provided
 * functions serialise to a body containing `[native code]`. Reconstructing
 * those via `new Function` produces a syntax-valid but runtime-broken
 * closure (the body literally tries to evaluate `[native code]` as JS).
 * Detect and fail fast with a clear, adopter-actionable message.
 *
 * The wrapping `(${source})(inputs, signal)` ensures arrow functions, async
 * functions, and named functions all parse identically inside the
 * `new Function` body.
 *
 * Security model: `source` here is `adopter.compute.toString()` — the
 * adopter's own function reference, derived at the JavaScript level. User
 * data flows through `inputs` (structured-clone), not through `source`.
 * The library exposes no path from user-supplied data to `new Function`.
 * The `[native code]` check is a developer-experience guard against an
 * easy-to-make mistake (passing a bound method), not a security boundary.
 */
function compileFromSource(source: string): CompiledCompute {
  if (source.includes("[native code]")) {
    throw new TypeError(
      "compute function source contains `[native code]` — bound, native, or " +
        "host-provided functions cannot be reconstructed in the worker. Pass " +
        "a plain function (or arrow function) as `compute`; if you need to " +
        "call a bound method, wrap it: `compute: (i, s) => boundMethod(i, s)`.",
    );
  }
  return new Function(
    "inputs",
    "signal",
    `return (${source})(inputs, signal);`,
  ) as CompiledCompute;
}

export interface ProductionRunnerStats {
  /** Number of unique source strings currently in the cache. */
  readonly cacheSize: number;
  /** Number of `new Function` invocations since the runner was created. */
  readonly compileCount: number;
}

export interface ProductionRunnerHandle {
  readonly runner: ComputeRunner;
  readonly stats: () => ProductionRunnerStats;
}

/**
 * Creates a production-mode `ComputeRunner` whose `Function` reconstruction
 * is cached per source string. At React's typical 60 Hz cadence, a stable
 * `compute` function would otherwise be re-parsed up to 60 times per second
 * — the cache turns this into a single parse + 59 hashmap lookups.
 *
 * The cache lives for the lifetime of the runner instance. `worker.ts`
 * instantiates one runner at worker boot; the cache fills with the source
 * strings the hook has actually shipped (typically one per hook instance).
 * Each new `Worker` (and therefore new `WorkerLoop`) starts with an empty
 * cache; this is correct because the compute function changing between
 * hook mounts is the normal mode.
 */
export function createProductionRunner(): ProductionRunnerHandle {
  const cache = new Map<string, CompiledCompute>();
  let compileCount = 0;
  const runner: ComputeRunner = async (inputs, signal, source) => {
    if (source === undefined) {
      throw new TypeError(
        "default worker received a compute request with no `source` — this " +
          "happens when `useCoherentDerivation` is called without `compute` " +
          "but the inlined worker is in use. Supply `compute` (inline), or " +
          "supply `workerFactory` returning a worker that bundles the compute " +
          "statically (and ignores `inbound.source`).",
      );
    }
    let fn = cache.get(source);
    if (fn === undefined) {
      fn = compileFromSource(source);
      cache.set(source, fn);
      compileCount += 1;
    }
    return await fn(inputs, signal);
  };
  return {
    runner,
    stats: () => ({ cacheSize: cache.size, compileCount }),
  };
}

/**
 * Default production runner. The library's worker entry (`worker.ts`)
 * imports this; tests that need cache-stat introspection use
 * `createProductionRunner()` directly to get a fresh, observable instance.
 */
export const productionRunner: ComputeRunner = createProductionRunner().runner;

export class WorkerLoop {
  private readonly controllers = new Map<SnapshotId, AbortController>();

  constructor(
    private readonly runner: ComputeRunner,
    private readonly reply: Reply,
  ) {}

  handle(message: WorkerInbound): void {
    switch (message.type) {
      case "compute":
        this.startCompute(message.id, message.inputs, message.source);
        return;
      case "abort":
        this.abortCompute(message.id);
        return;
      default:
        assertNever(message);
    }
  }

  private startCompute(
    id: SnapshotId,
    inputs: unknown,
    source: string | undefined,
  ): void {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.runner(inputs, controller.signal, source).then(
      (output) => {
        // A compute that resolves after its signal aborted is a stale
        // result — drop it. The strategy on the main side doesn't know to
        // discard it; the worker has the authoritative view of which ids
        // were aborted.
        if (!controller.signal.aborted) {
          this.reply({ type: "result", id, output });
        }
        this.controllers.delete(id);
      },
      (error) => {
        if (!controller.signal.aborted) {
          this.reply({ type: "error", id, error: serializeError(error) });
        }
        this.controllers.delete(id);
      },
    );
  }

  private abortCompute(id: SnapshotId): void {
    this.controllers.get(id)?.abort();
  }
}
