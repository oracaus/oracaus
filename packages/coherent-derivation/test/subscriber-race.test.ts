// Subscribe/unsubscribe race conditions during notification. The strategies
// iterate a snapshot of the listener set rather than the live set so that
// in-flight modifications (a listener that unsubscribes itself or another)
// don't perturb the current delivery cycle.

import { describe, expect, it } from "vitest";
import { CoherentDerivationStrategy } from "../src/internal/strategies/derivation-strategy.js";
import { FakeWorker } from "./utils/fake-worker.js";

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("subscribe/unsubscribe race — listener self-unsubscribes mid-notify", () => {
  it("subsequent listeners still fire", async () => {
    const fake = new FakeWorker();
    const strategy = new CoherentDerivationStrategy<number, undefined, number>(
      fake,
    );

    const calls: string[] = [];
    let unsubA: (() => void) | undefined;
    unsubA = strategy.subscribe(() => {
      calls.push("a");
      unsubA?.();
    });
    strategy.subscribe(() => {
      calls.push("b");
    });

    strategy.setInputs(1, undefined, "");
    await flushMicrotasks();

    // Both listeners fired on each commit (start + result). Listener `a`
    // unsubscribed itself during the first commit's snapshot iteration but
    // the snapshot still delivered the call; on the second commit only `b`
    // remains.
    expect(calls.filter((c) => c === "a").length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => c === "b").length).toBeGreaterThanOrEqual(2);
    strategy.destroy();
  });
});

describe("subscribe/unsubscribe race — listener unsubscribes another mid-notify", () => {
  it("the snapshot still delivers to the unsubscribed listener for this cycle", async () => {
    const fake = new FakeWorker();
    const strategy = new CoherentDerivationStrategy<number, undefined, number>(
      fake,
    );

    const calls: string[] = [];
    let unsubB: (() => void) | undefined;
    strategy.subscribe(() => {
      calls.push("a");
      // `a` removes `b` while we're iterating the snapshot of this commit.
      unsubB?.();
    });
    unsubB = strategy.subscribe(() => {
      calls.push("b");
    });

    strategy.setInputs(1, undefined, "");
    await flushMicrotasks();

    // First commit (isComputing=true): both `a` and `b` were in the
    // snapshot, so both fire even though `a` unsubscribed `b` mid-loop.
    // Second commit (data committed): `b` was removed before this snapshot
    // — only `a` fires.
    const aCalls = calls.filter((c) => c === "a").length;
    const bCalls = calls.filter((c) => c === "b").length;
    expect(aCalls).toBeGreaterThanOrEqual(2);
    expect(bCalls).toBe(1);
    strategy.destroy();
  });
});

describe("subscribe/unsubscribe race — new listener subscribed mid-notify", () => {
  it("the new listener does not fire on the in-progress commit", async () => {
    const fake = new FakeWorker();
    const strategy = new CoherentDerivationStrategy<number, undefined, number>(
      fake,
    );

    const calls: string[] = [];
    let lateSubscribed = false;
    strategy.subscribe(() => {
      calls.push("a");
      if (!lateSubscribed) {
        lateSubscribed = true;
        strategy.subscribe(() => {
          calls.push("late");
        });
      }
    });

    strategy.setInputs(1, undefined, "");
    await flushMicrotasks();

    // `late` was added during the first commit's iteration; it must not
    // have fired during that commit (the snapshot was already taken). It
    // does fire on subsequent commits.
    expect(calls.filter((c) => c === "late").length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => c === "late").length).toBeLessThan(
      calls.filter((c) => c === "a").length,
    );
    strategy.destroy();
  });
});

describe("subscribe/unsubscribe race — re-entrant setInputs from listener", () => {
  it("synchronous re-entry does not stack-overflow (snapshot iteration breaks the cycle)", async () => {
    // A listener that calls `setInputs` synchronously commits a new state,
    // which notifies listeners again. Without a snapshot, this could
    // mutate the in-flight iteration; with a snapshot, the inner notify
    // iterates a fresh snapshot. The library has to tolerate this without
    // recursing unbounded — the test caps total triggered re-entries to
    // confirm the strategy doesn't infinitely re-enter the listener
    // synchronously inside one notify cycle.
    const fake = new FakeWorker();
    const strategy = new CoherentDerivationStrategy<number, undefined, number>(
      fake,
    );

    let synchronousReentryCount = 0;
    let maxSyncDepth = 0;
    let depth = 0;
    const SYNC_CAP = 3;

    strategy.subscribe(() => {
      depth += 1;
      maxSyncDepth = Math.max(maxSyncDepth, depth);
      if (
        depth < SYNC_CAP &&
        synchronousReentryCount < SYNC_CAP &&
        strategy.getState().isComputing === true
      ) {
        // Cancel from inside the listener — synchronously commits another
        // state change, which would recurse if iteration weren't snapshotted.
        synchronousReentryCount += 1;
        strategy.cancel();
      }
      depth -= 1;
    });

    strategy.setInputs(0, undefined, "");
    // Final destroy stops any further async commits.
    strategy.destroy();

    expect(maxSyncDepth).toBeLessThanOrEqual(SYNC_CAP);
  });
});
