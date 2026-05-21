// ResizeObserver-backed measurement hook. Returns a ref to attach to a
// container plus the container's { width, height } in CSS pixels. Used
// by the Smile chart so it renders at the container's exact pixel size
// — strokes and text stay crisp regardless of container width, unlike
// `<svg viewBox>` + 100% scaling which stretches stroke widths and
// blurs label edges on wide screens.
//
// The initial render returns { 0, 0 }; consumers should guard the
// downstream render until size is non-zero. ResizeObserver fires
// synchronously after layout, so the second frame has the real value.

import { useEffect, useRef, useState } from "react";

export type ElementSize = { readonly width: number; readonly height: number };

export function useElementSize<
  T extends HTMLElement = HTMLDivElement,
>(): readonly [React.RefObject<T | null>, ElementSize] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      // Round to integers — sub-pixel widths cause SVG to anti-alias
      // tick lines and grid which looks fuzzy in the financial-domain
      // register.
      setSize((prev) => {
        const next = { width: Math.round(width), height: Math.round(height) };
        if (prev.width === next.width && prev.height === next.height) {
          return prev;
        }
        return next;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size] as const;
}
