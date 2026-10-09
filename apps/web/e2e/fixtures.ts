import fs from "node:fs";

import {
  test as base,
  expect,
  chromium,
  type Browser,
  type Page,
} from "@playwright/test";

import { dumpComputedStyles } from "./computed-style-dump";
import {
  sharedBrowserEnabled,
  sharedBrowserWsPath,
} from "./shared-browser-paths";

export { expect };
export type { Browser, Page };

type WorkerFixtures = {
  /**
   * Worker-scoped Browser handle. Either a private Chromium (default) or a
   * connection into the opt-in shared BrowserServer.
   */
  browser: Browser;
};

/**
 * Bounded parallelism with an explicit browser failure domain:
 * - Default: each worker owns one Chromium, limiting a crash or disconnect to
 *   that worker while tests still receive fresh isolated BrowserContexts.
 * - Set PLAYWRIGHT_SHARED_BROWSER=1 to connect every worker to one BrowserServer
 *   for controlled low-process measurements.
 */
export const test = base.extend<Record<string, never>, WorkerFixtures>({
  page: async ({ page }, providePage, testInfo) => {
    // A query that resolves to undefined means a fixture answered an endpoint
    // with the wrong shape; the real Hub never does. Fail here rather than
    // leave it to the Next dev overlay.
    const undefinedQueries: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && /Query data cannot be undefined|query resolved to undefined/u.test(message.text())) {
        undefinedQueries.push(message.text());
      }
    });
    await providePage(page);
    await dumpComputedStyles(page, testInfo);
    expect(undefinedQueries, "queries resolved to undefined (fixture shape mismatch)").toEqual([]);
  },
  browser: [
    async ({ playwright }, use) => {
      if (!sharedBrowserEnabled()) {
        const browser = await playwright.chromium.launch({
          headless: true,
          args: ["--disable-dev-shm-usage"],
        });
        await use(browser);
        await browser.close();
        return;
      }

      const wsPath = sharedBrowserWsPath();
      if (!fs.existsSync(wsPath)) {
        throw new Error(
          `Shared browser endpoint missing at ${wsPath}. ` +
            "globalSetup should have started hold-shared-browser.mjs.",
        );
      }
      const wsEndpoint = fs.readFileSync(wsPath, "utf8").trim();
      if (!wsEndpoint.startsWith("ws")) {
        throw new Error(`Invalid shared browser endpoint: ${wsEndpoint}`);
      }
      const browser = await chromium.connect(wsEndpoint);
      await use(browser);
      // Disconnect this worker only; the BrowserServer stays up for siblings.
      await browser.close();
    },
    { scope: "worker" },
  ],
});
