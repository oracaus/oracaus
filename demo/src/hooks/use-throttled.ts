// Throttle a fast-changing value to a slower update rate. Used for
// downstream consumers (OptionChainTable, etc.) that don't need to
// observe every tick — a 21-row × 7-cell numeric grid updating at
// 30 Hz is wasted work the eye can't read past ~5 Hz anyway.
//
// Pattern: stash the live value in a ref on every render; a
// setInterval flushes ref → state at the throttled cadence. Only
// triggers a downstream render when the flushed value differs from
// the previously flushed one (referential check, so wrap with stable
// inputs in a useMemo at the call site if needed).

import { useEffect, useRef, useState } from "react";

export function useThrottled<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const valueRef = useRef(value);
  valueRef.current = value;
  const lastFlushedRef = useRef(value);

  useEffect(() => {
    const id = setInterval(() => {
      const next = valueRef.current;
      if (next === lastFlushedRef.current) return;
      lastFlushedRef.current = next;
      setThrottled(next);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return throttled;
}
