// @vitest-environment node

// SSR shape verification. On the server, `useEffect` does not run — so the
// strategy is never instantiated and no worker is created. The hook reads
// `useSyncExternalStore`'s `getServerSnapshot` path, which returns the
// `initialState` snapshot. The component renders the loading shape and
// hydration on the client kicks off the first compute as normal.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useCoherentDerivation } from "../src/use-coherent-derivation.js";
import { asWorker } from "./utils/as-worker.js";
import { FakeWorker } from "./utils/fake-worker.js";

describe("useCoherentDerivation — SSR (`renderToString`)", () => {
  it("renders the initial state shape and does not construct a worker", () => {
    let workerFactoryCalls = 0;
    const factory = (): Worker => {
      workerFactoryCalls += 1;
      return asWorker(new FakeWorker());
    };
    const inputs = { foo: "bar" };
    const compute = async ({
      streaming,
    }: {
      streaming: typeof inputs;
      intent: undefined;
    }): Promise<typeof inputs> => streaming;

    const Display = (): React.ReactElement => {
      const { data, isComputing, dataSnapshotId, computingSnapshotId, error } =
        useCoherentDerivation({
          streaming: inputs,
          compute,
          workerFactory: factory,
        });
      return (
        <div data-testid="ssr">
          {JSON.stringify({
            data,
            isComputing,
            dataSnapshotId,
            computingSnapshotId,
            error,
          })}
        </div>
      );
    };

    const html = renderToString(<Display />);

    // Effects do not run on the server, so the workerFactory was never
    // invoked. (`useState`'s initialiser does run, producing a
    // StrategyHandle — that's intentional and free of side effects.)
    expect(workerFactoryCalls).toBe(0);

    // The serialised state matches the initial-state shape from
    // `strategy-state.ts`: data/snapshot ids undefined, isComputing false,
    // no error. JSON.stringify drops `undefined` properties, so the inner
    // text is `{"isComputing":false}` (HTML-encoded as `&quot;`).
    expect(html).toContain("&quot;isComputing&quot;:false");
    expect(html).not.toContain("&quot;data&quot;");
    expect(html).not.toContain("&quot;dataSnapshotId&quot;");
    expect(html).not.toContain("&quot;computingSnapshotId&quot;");
    expect(html).not.toContain("&quot;error&quot;");
  });

  it("the cancel function is callable in the SSR render path (no-op)", () => {
    let cancelInvocations = 0;
    const inputs = 1;
    const compute = async ({
      intent,
    }: {
      streaming: undefined;
      intent: number;
    }): Promise<number> => intent;

    const Probe = (): React.ReactElement => {
      const { cancel } = useCoherentDerivation({
        intent: inputs,
        compute,
      });
      // Calling `cancel` during render is documented as permitted-but-
      // pointless. On SSR with no strategy attached, it must not throw.
      try {
        cancel();
        cancelInvocations += 1;
      } catch {
        // unreached
      }
      return <div data-testid="probe">{cancelInvocations}</div>;
    };

    const html = renderToString(<Probe />);
    expect(html).toContain(">1<");
  });
});
