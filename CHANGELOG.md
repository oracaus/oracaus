# Changelog

## v0.2.0 — Causal Identity Coherence

### What Changed

v0.1.0 approximated coherence by checking whether messages arrived within a 50ms wall-clock window. This broke in both directions:

- **False coherence**: Two independent market events land within 50ms and the gate treats them as related — mixing unrelated position and Greeks updates into a single snapshot.
- **False incoherence**: A single fill event fans out across services with variable latency. The Greeks engine takes 60ms. The gate times out at 50ms and suppresses execution unnecessarily.

v0.2.0 replaces the time-based proxy with **causal identity**. Messages carry metadata (`correlationId`, `eventTimestamp`, or `globalSequence`) that identifies which market event produced them. The gate waits for all required streams to report the same causal key before emitting.

### Wall-Clock Fallback

When messages lack causal metadata, the extractor returns `null` and the gate automatically falls back to v0.1.0 wall-clock behaviour (50ms window). This makes v0.2.0 backwards-compatible with uninstrumented feeds.

## v0.3.0 (Planned)

1. **`fillGap()` method** — snapshot response path for `gapStrategy: 'snapshot-fetch'`
2. **Benchmarks** — false coherence rate under v0.1.0 vs v0.2.0 on a real feed under load
3. **Multi-instrument coherence** — cross-currency P&L where per-instrument causal keys diverge
4. **BackpressureValve causal metadata** — handling when `prices.passThrough = false`
