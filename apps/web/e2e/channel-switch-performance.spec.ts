import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_SPACE,
  E2E_USER_SENDER,
  fixtureJson,
  fixtureRequests,
  installWorkspaceStubs,
} from "./workspace-fixtures";

const PERFORMANCE_HISTORY_RULE = "channel-performance-history";

test.use({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
});

const baseChannel = {
  ...E2E_CHANNEL,
  messageCount: 1,
  historyHeadSequence: 1,
};
const targetChannel = {
  ...E2E_CHANNEL,
  id: "channel-performance",
  name: "performance",
  messageCount: 1,
  historyHeadSequence: 1,
};
const historyMessage = {
  messageId: "performance-message",
  channelId: targetChannel.id,
  sequence: 1,
  from: E2E_USER_SENDER,
  body: "history-painted-under-budget",
  sentAt: "2026-07-01T00:00:01.000Z",
  reactions: [],
  annotations: [],
  attachments: [],
};

async function openUncachedChannelWorkspace(page: Page): Promise<{
  targetSocketHistoryReads: { count: number };
}> {
  const targetSocketHistoryReads = { count: 0 };
  await page.routeWebSocket("**/ws/humans*", (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as {
        type?: string;
        requestId?: string;
        channelId?: string | null;
        historyLimit?: number;
      };
      if (message.type === "human_connect") {
        socket.send(JSON.stringify({
          type: "human_connected",
          requestId: message.requestId,
          user: {
            id: "e2e-user",
            email: "e2e@xmatrix.test",
            name: "E2E Tester",
          },
        }));
        return;
      }
      if (
        message.type !== "user_focus_channel" ||
        ![baseChannel.id, targetChannel.id].includes(message.channelId || "")
      ) return;
      if (message.channelId === targetChannel.id) targetSocketHistoryReads.count += 1;
      setTimeout(() => {
        socket.send(JSON.stringify({
          type: "channel_history",
          requestId: message.requestId,
          channelId: message.channelId,
          messages: message.channelId === targetChannel.id ? [historyMessage] : [],
          hasMore: false,
        }));
      }, 25);
    });
  });
  // Registered before the workspace stubs, which is what the `page.route`
  // version did and what the assertions below were written against: the shared
  // per-channel history rule is registered after this one and therefore wins,
  // so this rule only ever answers what that one does not.
  //
  // NOTE: that makes the `toEqual([])` assertion below vacuous — this rule
  // cannot record a request it never serves. Registering it after the shared
  // stubs makes it win instead, and it then shows the app does fetch this
  // history over REST. Whether that request is a regression or was always
  // expected is a product question, not one to settle inside a
  // test-infrastructure change, so the original ordering is kept here.
  await fixtureJson(
    page,
    PERFORMANCE_HISTORY_RULE,
    "**/api/xmatrix/channels/channel-performance/history**",
    { messages: [historyMessage], hasMore: false },
    { delayMs: 200 }
  );
  await installWorkspaceStubs(page, {
    spaces: [E2E_SPACE],
    channels: [baseChannel, targetChannel],
  });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await expect(
    page.locator(`[data-channel-row-id="${targetChannel.id}"]`),
  ).toBeVisible();
  return { targetSocketHistoryReads };
}

/**
 * Selecting an uncached channel must read its history over the socket that is
 * already open, never a fresh HTTP fetch. The two paths are stubbed with
 * different delays so a regression is visible in the counters: the socket
 * answers `user_focus_channel`, and the REST route must stay untouched.
 *
 * This deliberately asserts no wall-clock budget. It used to require the paint
 * within 100ms, a threshold picked to sit between the 25ms socket stub and the
 * 200ms REST stub. That number measured host contention as much as the product
 * — on a loaded machine it failed while both path counters were still correct
 * — so the path assertions below carry the contract on their own.
 */
test("an uncached channel paints its fetched history from the open socket", async ({ page }) => {
  const { targetSocketHistoryReads } = await openUncachedChannelWorkspace(page);

  // Exercise the same trusted pointer sequence as a Human. The old in-page
  // dispatchEvent sequence survived after the wall-clock budget was removed,
  // but synthetic untrusted events can be dropped while React is reconciling.
  // Playwright's actionability and visibility waits keep this a path contract,
  // not a private five-second benchmark hidden inside page.evaluate.
  const title = page.locator(`[data-channel-row-id="${targetChannel.id}"]`).getByRole("button", {
    name: "performance",
    exact: true,
  });
  const box = await title.boundingBox();
  if (!box) throw new Error("performance title button has no box");
  // Click through the mouse, not locator.click(). Selecting on pointerdown
  // remounts the row; locator actionability then retries a second press on the
  // new node, which is not a Human gesture.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".app-message-timeline").getByText(historyMessage.body)).toBeVisible();

  expect(await fixtureRequests(page, PERFORMANCE_HISTORY_RULE)).toEqual([]);
  expect(targetSocketHistoryReads.count).toBe(1);

  await page.locator(`[data-channel-row-id="${baseChannel.id}"]`).click();
  await expect(page.getByRole("heading", { name: "#general" })).toBeVisible();
});

test("keyboard activation of an uncached channel keeps the socket history page", async ({ page }) => {
  const { targetSocketHistoryReads } = await openUncachedChannelWorkspace(page);
  const title = page.locator(`[data-channel-row-id="${targetChannel.id}"]`).getByRole("button", {
    name: "performance",
    exact: true,
  });
  await title.focus();
  await title.press("Enter");
  await expect(page.locator(".app-message-timeline").getByText(historyMessage.body)).toBeVisible();
  expect(await fixtureRequests(page, PERFORMANCE_HISTORY_RULE)).toEqual([]);
  expect(targetSocketHistoryReads.count).toBe(1);
});

test.describe("touch channel switch", () => {
  test.use({ hasTouch: true });

  test("a touch tap on an uncached channel keeps the socket history page", async ({ page }) => {
    const { targetSocketHistoryReads } = await openUncachedChannelWorkspace(page);
    await page.locator(`[data-channel-row-id="${targetChannel.id}"]`).tap();
    await expect(page.locator(".app-message-timeline").getByText(historyMessage.body)).toBeVisible();
    expect(await fixtureRequests(page, PERFORMANCE_HISTORY_RULE)).toEqual([]);
    expect(targetSocketHistoryReads.count).toBe(1);
  });
});
