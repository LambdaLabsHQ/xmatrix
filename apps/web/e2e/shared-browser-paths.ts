import path from "node:path";
import process from "node:process";

/**
 * Paths for the shared Chromium BrowserServer.
 * Resolved from process.cwd() (Playwright runs with apps/web as cwd) so this
 * module stays valid when Playwright loads setup/fixtures as CJS.
 */
export function sharedBrowserStateDir(cwd = process.cwd()) {
  return path.join(cwd, "e2e", ".shared-browser");
}

export function sharedBrowserWsPath(cwd = process.cwd()) {
  return path.join(sharedBrowserStateDir(cwd), "ws-endpoint");
}

export function sharedBrowserPidPath(cwd = process.cwd()) {
  return path.join(sharedBrowserStateDir(cwd), "server.pid");
}

export function sharedBrowserHoldScript(cwd = process.cwd()) {
  return path.join(cwd, "e2e", "hold-shared-browser.mjs");
}

export function sharedBrowserEnabled(env: NodeJS.ProcessEnv = process.env) {
  // Keep the single BrowserServer available for controlled measurements, but
  // do not make it the complete matrix's default failure domain.
  return env.PLAYWRIGHT_SHARED_BROWSER === "1";
}
