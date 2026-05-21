// Umami analytics wrapper.
//
// `trackEvent` is a safe no-op when `window.umami` is absent — which is
// every local dev / preview run (the Vite plugin only injects the snippet
// when VITE_UMAMI_ENABLED=true, set only in the deploy workflow).
//
// Payload type is restricted to flat primitives to forbid PII leakage and
// nested objects; Umami's event-filter UI works best on flat shapes anyway.

declare global {
  interface Window {
    umami?: {
      track: (name: string, data?: Record<string, unknown>) => void;
    };
  }
}

export type EventPayload = Record<string, string | number | boolean>;

export function trackEvent(name: string, data?: EventPayload): void {
  if (typeof window === "undefined") return;
  window.umami?.track(name, data);
}
