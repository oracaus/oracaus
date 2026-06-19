import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Inject the Umami analytics snippet into <head> only when
// VITE_UMAMI_ENABLED=true. CI sets the flag for the production deploy
// (see .github/workflows/deploy-demo.yml); local `npm run dev` and
// `npm run preview` leave it unset so dev usage doesn't skew metrics.
const umamiPlugin: Plugin = {
  name: "inject-umami",
  transformIndexHtml() {
    if (process.env.VITE_UMAMI_ENABLED !== "true") return;
    return [
      {
        tag: "script",
        attrs: {
          defer: true,
          src: "https://cloud.umami.is/script.js",
          "data-website-id": "d04c743f-9e4f-4871-bf73-b68eef330839",
        },
        injectTo: "head",
      },
    ];
  },
};

// `base: "/"` for all modes: the production deploy serves at the
// subdomain root `https://demo.oracaus.dev` via the CNAME in
// `demo/public/CNAME`, so there's no subpath. Dev and preview both
// serve at localhost root too — no mode-conditional needed.
//
// `--mode profiling` (npm run build:profiling) swaps react-dom for its
// profiling build: a production-grade (minified, optimised) bundle that keeps
// the React DevTools Profiler / Timeline instrumentation enabled. One capture
// build then serves every DevTools shot — representative numbers AND a working
// Profiler — instead of switching between a dev build (for the Profiler) and a
// production build (for the numbers). The default `npm run build` (the deploy)
// is untouched: a clean production bundle with no profiler overhead. The app
// imports `createRoot` from `react-dom/client`, so the alias targets that
// specifier (not bare `react-dom`); `react-dom/profiling` re-exports the full
// client surface, `createRoot` included.
export default defineConfig(({ mode }) => ({
  base: "/",
  plugins: [react(), tailwindcss(), umamiPlugin],
  resolve: {
    alias: {
      // Workspace-internal package — alias to source so Vite picks up
      // edits to the library without a publish round-trip during demo dev.
      "@oracaus/coherent-derivation": path.resolve(
        dirname,
        "../packages/coherent-derivation/src/index.ts",
      ),
      ...(mode === "profiling"
        ? { "react-dom/client": "react-dom/profiling" }
        : {}),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
}));
