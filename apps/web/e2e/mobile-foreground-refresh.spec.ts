import { expect, test } from "./fixtures";
import fs from "node:fs";
import {
  E2E_CHANNEL, E2E_SPACE, E2E_USER_SENDER, E2E_MOBILE_CONTEXT,
  installWorkspaceStubs, fixtureJson, fixtureChannelCatalog, fixtureRequests, routeHumanSocket,
} from "./workspace-fixtures";

test.use(E2E_MOBILE_CONTEXT);

const message = (sequence: number) => ({
  messageId: `resume-${sequence}`, channelId: E2E_CHANNEL.id, sequence,
  from: E2E_USER_SENDER, body: `Foreground message ${sequence}`,
  sentAt: `2026-07-01T00:00:0${sequence}.000Z`,
  reactions: [], annotations: [], attachments: [],
});

test("mobile resume catches up history while an OPEN socket stops delivering", async ({ page }) => {
  let focused = 0;
  await routeHumanSocket(page, (frame, reply) => {
    if (frame.type === "user_focus_channel" && frame.channelId === E2E_CHANNEL.id) {
      focused++;
      reply({ type: "channel_history", channelId: frame.channelId,
        requestId: frame.requestId, messages: [message(1)], hasMore: false });
    }
    // Keep readyState OPEN but never answer ping or send subsequent deltas.
  });
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "initial-history", "**/api/xmatrix/channels/channel-general/history**",
    { messages: [message(1)], hasMore: false });
  await page.goto("/app/personal-sspaceperso/channels/general--channel-general");
  await expect(page.getByText("Foreground message 1", { exact: true })).toBeVisible();
  await expect.poll(() => focused).toBeGreaterThan(0);
  await fixtureJson(page, "resumed-history", "**/api/xmatrix/channels/channel-general/history**",
    { messages: [message(1), message(2)], hasMore: false });
  // Let the one-second HTTP cache expire, while remaining below heartbeat timeout.
  await page.waitForTimeout(1_100);
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
  });
  await expect(page.getByText("Foreground message 2", { exact: true })).toBeVisible({ timeout: 5_000 });
  expect(await fixtureRequests(page, "resumed-history")).toHaveLength(1);
});

test("mobile list refreshes on foreground without waiting for a socket reconnect", async ({ page }) => {
  await page.routeWebSocket("**/ws/humans*", socket => socket.onMessage(() => undefined));
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app/personal-sspaceperso/channels");
  await expect(page.locator(`[data-mobile-channel-row-id="${E2E_CHANNEL.id}"]`)).toBeVisible();
  const freshChannel = { ...E2E_CHANNEL, id: "newly-active", name: "Newly active conversation" };
  await fixtureChannelCatalog(page, "resumed-catalog", [freshChannel, E2E_CHANNEL]);
  // Foreground refresh ignores events within a second of the last one, and the
  // page's own load already sent focus/pageshow; a resume inside that window
  // is swallowed, so step past it the way the history resume above does.
  await page.waitForTimeout(1_100);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator('[data-mobile-channel-row-id="newly-active"]')).toBeVisible({ timeout: 5_000 });
  expect((await fixtureRequests(page, "resumed-catalog")).length).toBeGreaterThan(0);
});

test("cold mobile list does not download the document editor", async ({ page }) => {
  const manifest = JSON.parse(fs.readFileSync(".next/react-loadable-manifest.json", "utf8")) as
    Record<string, { files: string[] }>;
  const editor = Object.entries(manifest).find(([key]) => key.includes("page-editor"));
  expect(editor, "the document editor has an explicit lazy boundary").toBeDefined();
  const requested = new Set<string>();
  page.on("request", request => requested.add(new URL(request.url()).pathname));
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app/personal-sspaceperso/channels");
  await expect(page.locator(`[data-mobile-channel-row-id="${E2E_CHANNEL.id}"]`)).toBeVisible();
  for (const file of editor![1].files) {
    expect(requested.has(`/_next/${file}`), `list requested editor asset ${file}`).toBe(false);
  }
});
