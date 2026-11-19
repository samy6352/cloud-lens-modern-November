import { afterAll, afterEach } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ViteDevServer } from "vite";

export async function launchNativeBrowser(server?: ViteDevServer, routes: string[] = []): Promise<Browser> {
  if (server) {
    await Promise.all(["/src/router.tsx", ...routes].map(route => server.warmupRequest(route)));
  }
  const channel = import.meta.env.VITE_CLOUDLENS_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge", "chromium"].includes(channel)) {
    throw new Error("VITE_CLOUDLENS_BROWSER_CHANNEL must be chrome, msedge or chromium.");
  }
  return chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
}

export function nativeTestCleanup(browser: () => Browser | undefined, server: () => ViteDevServer | undefined, timeout?: number) {
  const closeContexts = async () => {
    await Promise.all((browser()?.contexts() ?? []).map(async context => {
      await context.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    }));
  };
  afterEach(closeContexts);
  afterAll(async () => {
    await closeContexts();
    const http = server()?.httpServer;
    const closingServer = server()?.close();
    if (http && "closeAllConnections" in http) http.closeAllConnections();
    await Promise.all([browser()?.close(), closingServer]);
  }, timeout);
}
