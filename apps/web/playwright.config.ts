import { availableParallelism } from "node:os";

import { defineConfig } from "@playwright/test";

import { WEB_E2E_FIXTURE_ENV } from "./e2e/fixture-env.mjs";
import { browserTraceMode, browserWorkerCount } from "./e2e/runtime-policy.mjs";

/* Browser e2e for the workspace shell. One production server boots with mock
   auth (NEXT_PUBLIC_XMATRIX_MOCK_AUTH_TOKEN) so no real login is needed; each spec
   intercepts /api/xmatrix/* in the page and supplies its own fixtures, so no
   hub or network access is required either. Port 4611 avoids the 3000/3001
   dev servers that may already run on a workstation.

   CI prebuilds via `pnpm e2e:build` (turbo-cached) and sets
   PLAYWRIGHT_PREBUILT=1 so this process only starts the already-built tree.
   Local ad-hoc runs still build then start unless that flag is set. Reusing a
   server is explicitly opt-in: several worktrees share this machine, and a
   healthy process on the default port may be serving a different commit.

   Workers use a bounded share of availableParallelism() so the production
   server and browser teardown retain CPU/I/O headroom. Each worker owns a
   Chromium by default; PLAYWRIGHT_SHARED_BROWSER=1 opts into the lower-process,
   larger-failure-domain BrowserServer mode for controlled measurements. */
const PORT = Number(process.env.PLAYWRIGHT_PORT || 4611);
const PREBUILT = process.env.PLAYWRIGHT_PREBUILT === "1";
const FIXTURE_ENV = WEB_E2E_FIXTURE_ENV;

export default defineConfig({
  testDir: "./e2e",
  // Relative paths: Playwright loads this config as CJS and rejects import.meta.
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // Every test receives its own BrowserContext, so tests inside one spec file
  // are just as isolated as tests from different files. Keep case-level
  // scheduling enabled to avoid one large spec becoming the serial tail.
  fullyParallel: true,
  workers: browserWorkerCount(availableParallelism()),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  projects: [
    {
      name: "web",
      testIgnore: [
        "**/*-performance.spec.ts",
        "**/composer-glass.spec.ts",
      ],
    },
    {
      name: "mock-app",
      testMatch: "**/composer-glass.spec.ts",
    },
    {
      // Run the wall-clock product budget after the functional matrix. Mixing
      // a benchmark into ten-way renderer startup measures host contention,
      // not channel-switch latency; functional cases remain fully parallel.
      name: "performance",
      testMatch: "**/*-performance.spec.ts",
      dependencies: ["web", "mock-app"],
    },
  ],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // A missing control should enter the existing retry path promptly instead
    // of letting one locator action consume the complete 90-second test budget.
    actionTimeout: 15_000,
    trace: browserTraceMode(Boolean(process.env.CI)),
    /* iPhone 14 Pro-class viewport; the switcher under test is mobile-only
       (md:hidden). Desktop cases override viewport via test.use(). */
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  webServer: {
    command: PREBUILT
      ? `pnpm exec next start -p ${PORT}`
      : `pnpm build && pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/app`,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    // Prebuilt trees only need a few seconds to listen; full local build+start
    // can still take several minutes on a cold machine.
    timeout: PREBUILT ? 60_000 : 240_000,
    env: FIXTURE_ENV,
  },
});
