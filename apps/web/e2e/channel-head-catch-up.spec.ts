import { expect, test, type Page } from "./fixtures";
import {
  E2E_CHANNEL, E2E_SPACE, E2E_USER_SENDER, E2E_MOBILE_CONTEXT,
  installWorkspaceStubs, fixtureJson, fixtureChannelCatalog, fixtureRequests,
  routeHumanSocket,
} from "./workspace-fixtures";

/* The open conversation never lags the channel list. An iOS WebView resumes
   with a Human socket that is still OPEN but delivers nothing, and the
   heartbeat only notices minutes later; the catalog head the list previews is
   what makes the timeline read the gap over HTTP. */

test.use(E2E_MOBILE_CONTEXT);

const authority = { protocolVersion: 1, contentRevision: 1 };

const message = (sequence: number) => ({
  messageId: `head-${sequence}`, channelId: E2E_CHANNEL.id, sequence,
  from: E2E_USER_SENDER, body: `Head message ${sequence}`,
  sentAt: `2026-07-01T00:00:0${sequence}.000Z`,
  reactions: [], annotations: [], attachments: [],
});

const channelAtHead = (head: number) => ({
  ...E2E_CHANNEL, historyHeadSequence: head, messageCount: head, contentAuthority: authority,
  updatedAt: message(head).sentAt,
  lastMessage: { messageId: `head-${head}`, sequence: head, bodyPreview: `Head message ${head}`,
    sentAt: message(head).sentAt, from: E2E_USER_SENDER },
});

/** A socket that answers the first focus and then goes silent, pings included. */
async function routeSilentSocket(page: Page) {
  const frames: string[] = [];
  let answered = false;
  await routeHumanSocket(page, (frame, reply) => {
    frames.push(frame.type ?? "");
    if (frame.type === "user_focus_channel" && frame.channelId === E2E_CHANNEL.id && !answered) {
      answered = true;
      reply({ type: "channel_history", channelId: frame.channelId,
        requestId: frame.requestId, messages: [message(1)], hasMore: false });
    }
  });
  return frames;
}

async function openChannelAtHeadOne(page: Page) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channelAtHead(1)] });
  await fixtureJson(page, "history-1", "**/api/xmatrix/channels/channel-general/history**",
    { messages: [message(1)], hasMore: false, historyHeadSequence: 1, contentAuthority: authority });
  await page.goto("/app/personal-sspaceperso/channels/general--channel-general");
  await expect(page.getByText("Head message 1", { exact: true })).toBeVisible();
}

async function serveHeadTwo(page: Page) {
  await fixtureChannelCatalog(page, "catalog-2", [channelAtHead(2)]);
  await fixtureJson(page, "history-2", "**/api/xmatrix/channels/channel-general/history**",
    { messages: [message(2)], hasMore: false, historyHeadSequence: 2, contentAuthority: authority });
}

test("an open channel reads what its list row previews when the socket stopped delivering", async ({ page }) => {
  const frames = await routeSilentSocket(page);
  await openChannelAtHeadOne(page);
  await serveHeadTwo(page);
  await page.evaluate(spaceId => window.dispatchEvent(new CustomEvent(
    "xmatrix:channel-catalog-change", { detail: { spaceId, kind: "structure" } },
  )), E2E_SPACE.id);

  await expect(page.getByText("Head message 2", { exact: true })).toBeVisible({ timeout: 5_000 });
  const reads = (await fixtureRequests(page, "history-2")).map((url) => new URL(url, "http://e2e.test").searchParams);
  expect(reads.some((params) => params.get("afterSequence") === "1")).toBe(true);
  // The socket missed a row, so it is checked now rather than at the next heartbeat.
  await expect.poll(() => frames.includes("ping")).toBe(true);
});

test("tapping a channel from the list shows the row its preview names", async ({ page }) => {
  await routeSilentSocket(page);
  await openChannelAtHeadOne(page);
  await page.getByRole("button", { name: "Back to channels" }).tap();
  const row = page.locator(`[data-mobile-channel-row-id="${E2E_CHANNEL.id}"]`);
  await expect(row).toBeVisible();

  await serveHeadTwo(page);
  await page.evaluate(spaceId => window.dispatchEvent(new CustomEvent(
    "xmatrix:channel-catalog-change", { detail: { spaceId, kind: "structure" } },
  )), E2E_SPACE.id);
  await expect(row).toContainText("Head message 2");
  await row.tap();

  await expect(page.getByText("Head message 2", { exact: true })).toBeVisible({ timeout: 3_000 });
});

test("after a WebView reload, a channel shows rows newer than its disk tail", async ({ page }) => {
  await routeSilentSocket(page);
  await openChannelAtHeadOne(page);
  // Let the durable tail cache persist the one-row window.
  await page.waitForTimeout(2_000);

  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channelAtHead(2)] });
  await fixtureJson(page, "history-reload", "**/api/xmatrix/channels/channel-general/history**",
    { messages: [message(1), message(2)], hasMore: false, historyHeadSequence: 2, contentAuthority: authority });
  await page.goto("/app/personal-sspaceperso/channels");
  await page.locator(`[data-mobile-channel-row-id="${E2E_CHANNEL.id}"]`).tap();

  await expect(page.getByText("Head message 2", { exact: true })).toBeVisible({ timeout: 3_000 });
});
