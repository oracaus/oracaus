# Causally Consistent UI

The provided code focuses exclusively on the complex, real-time portion of the client-side architecture from _The Six Frontend Architecture Failures Nobody Solves Before Production_: coordinating live WebSocket streams through the SharedWorker, BackpressureValve, and RenderGate to ensure temporal coherence and prevent mathematically invalid P&L renders.

## The pipeline

```
Raw WebSocket (2,000 ticks/sec)
         │
         ▼
┌───────────────────┐
│                   │  Stage 1: drop unwatched instruments
│ BackpressureValve │  Stage 2: classify by viewport × interaction
│                   │  Stage 3: conflate + throttle to 60fps
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│                   │  Hold render until Price, Position, Greeks
│    RenderGate     │  are within 50ms of each other.
│                   │  Prevents mathematically invalid P&L.
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│   SharedWorker    │  Single WebSocket connection across all tabs.
│  (Orchestrator)   │  Broadcasts CoherentSnapshot via BroadcastChannel.
└────────┬──────────┘
         │  BroadcastChannel
         ▼
┌─────────────────────────────┐
│  Tab 1  │  Tab 2  │  Tab 3  │  All tabs see identical state.
└─────────────────────────────┘
```

## File map

| File                          | Layer              | Failure it prevents                                          |
| ----------------------------- | ------------------ | ------------------------------------------------------------ |
| `backpressure-valve.ts`       | Filter + throttle  | Browser freeze during volatility event                       |
| `render-gate.ts`              | Causal consistency | Mathematically invalid P&L from mixed timestamps             |
| `orchestrator.worker.ts`      | SharedWorker       | Diverged truth across tabs; multiplied WebSocket connections |
| `client-bridge.ts`            | Tab interface      | Uncoordinated multi-tab state                                |
| `react/use-trading-stream.ts` | React integration  | Subscription lifecycle leaks; stale viewport signals         |

## Quick start

```tsx
import { useTradingStream } from "./react/use-trading-stream";

function BlotterRow({ instrumentId }: { instrumentId: string }) {
  const { snapshot, connectionStatus, sequenceId } = useTradingStream({
    instrumentIds: [instrumentId],
    viewportIds: isRowVisible ? [instrumentId] : [],
  });

  if (!snapshot) return <Skeleton />;

  const price = snapshot.prices[instrumentId];
  const position = snapshot.positions[instrumentId];

  // Safe to compute — RenderGate guarantees these are from
  // the same logical moment in time.
  const pnl =
    price && position
      ? (price.mid - position.avgCost) * position.quantity
      : null;

  return (
    <tr>
      <td>{price?.mid.toFixed(4)}</td>
      <td>{position?.quantity}</td>
      <td style={{ color: pnl != null && pnl < 0 ? "red" : "green" }}>
        {pnl?.toFixed(2)}
      </td>
    </tr>
  );
}
```

## What to wire up

1. **`orchestrator.worker.ts`** — replace `WS_URL` and adapt the `route()` function
   to your wire protocol. The expected shape is:

   ```json
   { "stream": "prices", "payload": { "instrumentId": "EUR/USD", "bid": 1.08, ... } }
   ```

2. **Viewport signalling** — pass `viewportIds` from an `IntersectionObserver`
   so the BackpressureValve can correctly classify off-screen instruments.

3. **Client-side threat model** — add TTL-based cache clearing on the
   SharedWorker side for shared terminals. Position caching on a shared
   terminal is a data exposure risk.

## Key architectural invariants

- **Authoritative source**: the SharedWorker is the single source of truth.
  REST snapshots are used only for initial load; the live stream supersedes them.
- **Optimistic rollbacks**: not implemented here — add an optimistic state layer
  above the snapshot in your state manager of choice. The library is the _last_
  decision, not the first.
- **Regulatory audit trail**: the `sequenceId` on each `CoherentSnapshot` gives
  you a monotonic render ledger. Persist these if compliance requires a
  client-side audit trail.
- **Partial snapshots**: `isPartial: true` on a snapshot means the RenderGate
  timed out waiting for full coherence. Consider suppressing tradeable actions
  (order submission, limit edits) when `isPartial` is true.
