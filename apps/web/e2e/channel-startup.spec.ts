import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  E2E_CHANNEL, E2E_SPACE, E2E_USER_SENDER, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT,
  installWorkspaceStubs, fixtureRule, fixtureJson, fixtureRequests, releaseFixture, channelHistoryFixture,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const BACKGROUND_READS = ["workspaces", "automations", "machine-daemons"];

async function expectBackgroundReads(page: Page, started: boolean, timeout?: number) {
  for (const id of BACKGROUND_READS) {
    if (started) {
      await expect.poll(async () => (await fixtureRequests(page, id)).length,
        { message: id, ...(timeout === undefined ? {} : { timeout }) }).toBeGreaterThan(0);
    } else {
      expect(await fixtureRequests(page, id), id).toHaveLength(0);
    }
  }
}

async function openPendingStartup(page: Page, id: string, pattern: string, expectedCount?: number) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureRule(page, { id, pattern, responder: { kind: "deferred", json: {} } });
  await page.goto("/app/personal-sspaceperso/channels", { waitUntil: "domcontentloaded" });
  const count = expect.poll(async () => (await fixtureRequests(page, id)).length);
  if (expectedCount === undefined) await count.toBeGreaterThan(0);
  else await count.toBe(expectedCount);
}

async function expectStartupDeadlineEscape(page: Page) {
  expect(await fixtureRequests(page, "automations")).toHaveLength(0);
  await expect.poll(async () => (await fixtureRequests(page, "automations")).length,
    { timeout: 12_000 }).toBeGreaterThan(0);
}

test.describe("Desktop startup with no Channel named", () => {
  for (const outcome of ["empty", "error"] as const) {
    test(`a desktop catalog with ${outcome} releases background work without history`, async ({ page }) => {
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [] });
      await fixtureRule(page, { id: "desktop-catalog", pattern: "**/api/xmatrix/channels/page**",
        responder: { kind: "deferred", status: outcome === "error" ? 403 : 200,
          json: outcome === "error" ? { error: "No access" } : {
            protocolVersion: 1, catalogRevision: 1, rows: [], nextCursor: null, counts: null,
          } } });
      await page.goto("/app/personal-sspaceperso/channels", { waitUntil: "domcontentloaded" });
      await expect.poll(async () => (await fixtureRequests(page, "desktop-catalog")).length).toBe(1);
      expect(await fixtureRequests(page, "automations")).toHaveLength(0);
      await releaseFixture(page, "desktop-catalog");
      await expectBackgroundReads(page, true, 3_000);
    });
  }
  test("no Channel opens by itself: the list is the answer and background work starts", async ({ page }) => {
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
    await fixtureJson(page, "unasked-history", "**/api/xmatrix/channels/channel-general/history**",
      { messages: [], hasMore: false, historyHeadSequence: 0 });
    await page.goto("/app/personal-sspaceperso/channels", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "general", exact: true })).toBeVisible();
    await expectBackgroundReads(page, true, 3_000);
    await expect(page).toHaveURL(/\/channels$/u);
    expect(await fixtureRequests(page, "unasked-history"), "no history is read for a Channel nobody opened").toHaveLength(0);
  });
});

test("exact Channel links start history before resolve and defer secondary requests", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [] });
  await fixtureRule(page, { id: "startup-resolve", pattern: "**/api/xmatrix/channels/resolve",
    responder: { kind: "deferred", json: { protocolVersion: 1, channels: [E2E_CHANNEL],
      pathsByChannelId: { [E2E_CHANNEL.id]: [E2E_CHANNEL.id] } } } });
  await fixtureJson(page, "startup-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: [{ messageId: "startup-message", channelId: E2E_CHANNEL.id, sequence: 1,
      from: E2E_USER_SENDER, body: "Startup history ready", sentAt: "2026-07-01T00:00:01.000Z",
      reactions: [], annotations: [], attachments: [] }],
    hasMore: false, historyHeadSequence: 1,
  });
  await page.goto("/app/personal-sspaceperso/channels/general--channel-general", { waitUntil: "domcontentloaded" });
  await expect.poll(async () => (await fixtureRequests(page, "startup-history")).length).toBe(1);
  await expect(page.getByText("Startup history ready", { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await fixtureRequests(page, "startup-resolve")).length).toBe(1);
  expect(await fixtureRequests(page, "automations")).toHaveLength(0);
  await releaseFixture(page, "startup-resolve");
  await expect(page.getByText("Startup history ready", { exact: true })).toBeVisible();
  expect(await fixtureRequests(page, "client-compatibility")).toHaveLength(1);
  expect((await fixtureRequests(page, "startup-history")).filter(url =>
    new URL(url).searchParams.get("limit") === "10")).toHaveLength(1);
});

test("resolving an anonymous session does not repeat compatibility admission", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true;
  });
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureRule(page, { id: "startup-auth-session", pattern: "**/api/auth/get-session**",
    responder: { kind: "deferred", json: {
      user: { id: "e2e-user", email: "e2e@xmatrix.test", name: "E2E Tester" },
      session: { token: "test-session", expiresAt: "2099-01-01T00:00:00.000Z" },
    } } });
  await fixtureJson(page, "startup-auth-token", "**/api/auth/token**", { token: "test-jwt" });
  await page.goto("/app/personal-sspaceperso/channels/general--channel-general", { waitUntil: "domcontentloaded" });
  await expect.poll(async () => (await fixtureRequests(page, "client-compatibility")).length).toBe(1);
  await releaseFixture(page, "startup-auth-session");
  await expect.poll(async () => (await fixtureRequests(page, "startup-auth-token")).length).toBeGreaterThan(0);
  await expect.poll(async () => (await fixtureRequests(page, "channel-catalog")).length).toBeGreaterThan(0);
  expect(await fixtureRequests(page, "client-compatibility")).toHaveLength(1);
});

// A native session completes after admission, replacing the account QueryClient.
// The admitted shell must stay mounted while the first private reads are pending.
test.describe("Native startup", () => {
  test.use(E2E_MOBILE_CONTEXT);
  for (const platform of ["android", "ios"] as const) {
    test(`${platform} authentication does not cancel and reissue the first Space read`, async ({ page }) => {
      await page.addInitScript((platform) => {
        (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true;
        (window as unknown as Record<string, unknown>).__nativeTabStates = [];
        (window as unknown as Record<string, unknown>).xmatrixDesktop = {
          client: platform, platform,
          getContext: async () => {
            // A native round trip completes on a later task, not an in-page microtask.
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { client: platform, platform, version: "0.16.301" };
          },
          setMobileTabState: async (state: unknown) => {
            ((window as unknown as Record<string, unknown>).__nativeTabStates as unknown[]).push(state);
          },
          setBadge: async () => undefined, setTitle: async () => undefined,
          notify: async () => true, openExternal: async () => undefined,
          checkCliInstalled: async () => ({ installed: false }),
          getUpdateStatus: async () => ({ state: "disabled", enabled: false }),
        };
      }, platform);
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
      await fixtureRule(page, { id: "native-session", pattern: "**/api/xmatrix/native-session",
        responder: { kind: "deferred", json: { session: {
          token: "test-jwt", refreshToken: "test-refresh", user: {
            id: "e2e-user", email: "e2e@xmatrix.test", name: "E2E Tester",
          }, hubUrl: "https://hub.example.test", relayUrl: "wss://hub.example.test",
        } } } });
      await fixtureRule(page, { id: "startup-spaces", pattern: /\/api\/xmatrix\/spaces$/,
        responder: { kind: "deferred", json: { spaces: [E2E_SPACE] } } });
      await page.goto("/app", { waitUntil: "domcontentloaded" });
      await expect.poll(async () => (await fixtureRequests(page, "client-compatibility")).length).toBe(1);
      await releaseFixture(page, "native-session");
      await expect.poll(async () => (await fixtureRequests(page, "startup-spaces")).length).toBe(1);
      await releaseFixture(page, "startup-spaces");
      await expect.poll(async () => (await fixtureRequests(page, "channel-catalog")).length).toBeGreaterThan(0);
      expect(await fixtureRequests(page, "startup-spaces")).toHaveLength(1);
      expect(await fixtureRequests(page, "client-compatibility")).toHaveLength(1);
      if (platform === "ios") {
        const lastTabState = () => page.evaluate(() => {
          const states = (window as unknown as Record<string, unknown>).__nativeTabStates as unknown[];
          return states.at(-1);
        });
        await expect.poll(lastTabState).toEqual({
          visible: true, activeView: "messages", spaceId: E2E_SPACE.id, userId: "e2e-user",
        });
        await page.locator('[data-mobile-channel-row-id="channel-general"]').tap();
        await expect.poll(lastTabState).toEqual({
          visible: false, activeView: "messages", spaceId: E2E_SPACE.id, userId: "e2e-user",
        });
      }
    });
  }
});

test.describe("Channel list foreground loading", () => {
  test.use(E2E_MOBILE_CONTEXT);

  for (const outcome of ["rows", "empty", "error"] as const) {
    test(`releases background reads after the first catalog ${outcome}`, async ({ page }) => {
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
      await fixtureRule(page, { id: "startup-list", pattern: "**/api/xmatrix/channels/page**",
        responder: { kind: "deferred", status: outcome === "error" ? 403 : 200,
          json: outcome === "error" ? { error: "No access" } : {
            protocolVersion: 1, catalogRevision: 1,
            rows: outcome === "rows" ? [{ channel: E2E_CHANNEL, hasChildren: false,
              ownActivityAt: E2E_CHANNEL.updatedAt }] : [],
            nextCursor: null, counts: { active: outcome === "rows" ? 1 : 0, archive: 0 },
          } } });
      await page.goto("/app/personal-sspaceperso/channels", { waitUntil: "domcontentloaded" });
      await expect.poll(async () => (await fixtureRequests(page, "startup-list")).length).toBe(1);
      await expectBackgroundReads(page, false);
      await releaseFixture(page, "startup-list");
      if (outcome === "rows") {
        await expect(page.locator(`[data-mobile-channel-row-id="${E2E_CHANNEL.id}"]`)).toBeVisible();
      }
      await expectBackgroundReads(page, true);
    });
  }


  test("switching away from a pending list immediately enables the requested view", async ({ page }) => {
    await openPendingStartup(page, "startup-list", "**/api/xmatrix/channels/page**", 1);
    expect(await fixtureRequests(page, "machine-daemons")).toHaveLength(0);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect.poll(async () => (await fixtureRequests(page, "machine-daemons")).length,
      { timeout: 3_000 }).toBeGreaterThan(0);
  });

  test("a stuck catalog cannot starve background views indefinitely", async ({ page }) => {
    await openPendingStartup(page, "startup-list", "**/api/xmatrix/channels/page**", 1);
    await expectStartupDeadlineEscape(page);
  });
});


test("Electron reads history from the Hub", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).xmatrixDesktop = {
      client: "desktop", platform: "darwin",
      getContext: async () => ({ client: "desktop", platform: "darwin", version: "0.16.315" }),
      setBadge: async () => undefined, setTitle: async () => undefined,
      notify: async () => true, openExternal: async () => undefined,
      checkCliInstalled: async () => ({ installed: false }),
      getUpdateStatus: async () => ({ state: "disabled", enabled: false }),
    };
  });
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "electron-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: channelHistoryFixture(1, "electron-browser").map(message => ({
      ...message, body: "Electron browser history ready",
    })),
    hasMore: false, historyHeadSequence: 1,
  });
  await page.goto("/app/personal-sspaceperso/channels/general--channel-general", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Electron browser history ready", { exact: true })).toBeVisible();
});
