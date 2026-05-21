// @oracaus/connection-layer — workspace-internal in v0.5.0; not yet published.
//
// SharedWorker-based connection layer for high-frequency streaming web apps.
// Single WebSocket per browser session, shared across tabs via BroadcastChannel.
// BackpressureValve does viewport-aware tick conflation inside the worker.
//
// What this package does NOT do (post-v0.5.0):
//   - Cross-stream causal coherence (RenderGate). That was the v0.4.0 shape;
//     the pivot article explains why fan-in alignment is the middle tier's job
//     in financial-services architectures. Per-stream messages flow through;
//     consumers compose them with their own dep-graph or with
//     `@oracaus/coherent-derivation` for heavy compute.
//
// React adopters import the `./react` subpath for `useTradingStream`. The
// orchestrator worker is loaded internally via `new SharedWorker(...)`; do
// not import it directly.

export { BackpressureValve } from "./backpressure-valve.js";
export { ClientBridge } from "./client-bridge.js";

export type {
  CausalMetadata,
  ConnectionStatus,
  CurrencyCode,
  Delta,
  Gamma,
  GreeksUpdate,
  InstrumentId,
  PositionUpdate,
  Price,
  PriceTick,
  Quantity,
  RenderPriority,
  StreamId,
  Theta,
  Timestamp,
  Vega,
  WorkerInbound,
  WorkerOutbound,
} from "./types.js";

export { assertNever } from "./types.js";
