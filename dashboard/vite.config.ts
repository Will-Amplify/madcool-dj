import { defineConfig } from "vite";

// Dev only: the built dashboard is served directly by dj-control (see
// control/src/routes.ts). In dev, Vite runs on :5173 and proxies both the
// REST surface and the /v1/live WebSocket through to dj-control on :8787
// so relative fetch("/v1/...") calls work unmodified in both modes.
export default defineConfig({
  server: {
    proxy: {
      "/v1": {
        target: "http://localhost:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
