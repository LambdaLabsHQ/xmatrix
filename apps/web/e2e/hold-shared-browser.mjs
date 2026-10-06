#!/usr/bin/env node
/**
 * Long-lived Chromium BrowserServer for Playwright workers to connect to.
 * Spawned detached from globalSetup so it outlives the setup process.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

const stateDir = process.argv[2];
if (!stateDir) {
  console.error("hold-shared-browser: missing state directory argument");
  process.exit(1);
}

fs.mkdirSync(stateDir, { recursive: true });

const server = await chromium.launchServer({
  headless: true,
  args: [
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--mute-audio",
  ],
});

const wsEndpoint = server.wsEndpoint();
fs.writeFileSync(pathJoin(stateDir, "ws-endpoint"), wsEndpoint, "utf8");
fs.writeFileSync(pathJoin(stateDir, "server.pid"), String(process.pid), "utf8");
// Signal readiness on stdout for the parent that may be polling the file.
process.stdout.write(`${wsEndpoint}\n`);

async function shutdown() {
  try {
    await server.close();
  } catch {
    // Server may already be gone.
  }
  try {
    fs.rmSync(pathJoin(stateDir, "ws-endpoint"), { force: true });
    fs.rmSync(pathJoin(stateDir, "server.pid"), { force: true });
  } catch {
    // Best-effort cleanup.
  }
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

function pathJoin(root, name) {
  return `${root.replace(/\/$/, "")}/${name}`;
}

// Keep the event loop alive until signalled.
await new Promise(() => {});
