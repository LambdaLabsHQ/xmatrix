import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium, type FullConfig } from "@playwright/test";

import {
  sharedBrowserEnabled,
  sharedBrowserHoldScript,
  sharedBrowserPidPath,
  sharedBrowserStateDir,
  sharedBrowserWsPath,
} from "./shared-browser-paths";

/**
 * Start one Chromium BrowserServer, warm the production shell so workers share
 * HTTP cache / process overhead, then leave the server running for connect().
 *
 * High worker counts stay parallel (many BrowserContexts) without paying for
 * N independent Chromium process trees and N simultaneous cold /app loads.
 */
export default async function globalSetup(config: FullConfig) {
  if (!sharedBrowserEnabled()) {
    console.log("[e2e] isolated worker browsers enabled (set PLAYWRIGHT_SHARED_BROWSER=1 to share)");
    return;
  }

  const cwd = process.cwd();
  const stateDir = sharedBrowserStateDir(cwd);
  const wsPath = sharedBrowserWsPath(cwd);
  const pidPath = sharedBrowserPidPath(cwd);
  const holdScript = sharedBrowserHoldScript(cwd);

  fs.mkdirSync(stateDir, { recursive: true });
  for (const file of [wsPath, pidPath]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }

  const child = spawn(process.execPath, [holdScript, stateDir], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.unref();

  if (child.pid) {
    fs.writeFileSync(pidPath, String(child.pid), "utf8");
  }

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[shared-browser] ${chunk}`);
  });

  const wsEndpoint = await waitForWsEndpoint(wsPath, 30_000);
  const baseURL = resolveBaseURL(config);
  await warmSharedBrowser(wsEndpoint, baseURL);
  console.log(
    `[e2e] shared Chromium ready ws=${wsEndpoint} warmed=${baseURL}/app (workers connect; contexts stay isolated)`,
  );
}

function resolveBaseURL(config: FullConfig) {
  const fromProject = config.projects.find((project) => project.use?.baseURL)?.use?.baseURL;
  if (typeof fromProject === "string" && fromProject.length > 0) {
    return fromProject.replace(/\/$/, "");
  }
  const port = process.env.PLAYWRIGHT_PORT || "4611";
  return `http://localhost:${port}`;
}

async function waitForWsEndpoint(wsPath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(wsPath)) {
        const value = fs.readFileSync(wsPath, "utf8").trim();
        if (value.startsWith("ws")) return value;
      }
    } catch {
      // retry
    }
    await delay(50);
  }
  throw new Error(
    `Shared Chromium BrowserServer did not publish a ws endpoint within ${timeoutMs}ms (${wsPath})`,
  );
}

async function warmSharedBrowser(wsEndpoint: string, baseURL: string) {
  const browser = await chromium.connect(wsEndpoint);
  try {
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    // Populate the single-browser HTTP cache and V8 code cache for /app
    // before workers fan out. Subsequent parallel navigations then
    // reuse process-local cache instead of thrashing N cold Chromium trees.
    await page.goto(`${baseURL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await context.close();
  } finally {
    await browser.close();
  }
}
