import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const backend = process.env.CLOUDLENS_BACKEND ?? "http://localhost:8100";

// Served by FastAPI under /v2 (see app/main.py). The build lands in ../web/v2 so the existing
// packaging (tools/package.ps1) ships it with the rest of web/ and nothing else needs to know.
export default defineConfig({
  base: "/v2/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Natural Earth geometry generated once by tools/build_worldmap.py and shared with the classic UI.
      "@cl/worldmap": fileURLToPath(new URL("../web/assets/worldmap.js", import.meta.url)),
    },
  },
  build: {
    outDir: "../web/v2",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin in dev too: the session cookie, /login redirects and the API all come from the
    // FastAPI app, so the dev server behaves exactly like /v2 in production.
    proxy: Object.fromEntries(
      ["/api", "/login", "/auth", "/assets", "/healthz"].map((path) => [
        path,
        { target: backend, changeOrigin: false },
      ]),
    ),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
