import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  channelHistoryFixture,
  conversationOpened,
  fixtureJson,
  installWorkspaceStubs,
} from "./workspace-fixtures";

/* Opening a conversation used to show an empty timeline for a quarter of a
   second - on a phone, for the whole slide - and then fill it in one frame:
   the virtual list keeps its rows hidden until it has landed on the last one
   (user 2026-10-10: "点开和回去频道的过程不丝滑…整个过程避免闪烁"). The conversation now
   opens on its last screen of rows, drawn in the commit that opens it, and
   the list takes them over where they are.

   Every frame is read, so this holds whatever the host's speed: no frame of
   an open conversation is without its newest message, and that message does
   not move when the list takes over. */

const HISTORY_LENGTH = 30;
const NEWEST_ROW_ID = `message:first-frame-${HISTORY_LENGTH}`;

type Frame = { open: boolean; newestTop: number | null };

async function openWorkspace(page: Page, path: string) {
  await installWorkspaceStubs(page, {
    spaces: [E2E_SPACE],
    channels: [
      { ...E2E_CHANNEL, updatedAt: E2E_NOW, messageCount: HISTORY_LENGTH, lastMessageSequence: HISTORY_LENGTH },
      { ...E2E_CHANNEL, id: "channel-quiet", name: "quiet", updatedAt: E2E_NOW },
    ],
  });
  await fixtureJson(page, "first-frame-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: channelHistoryFixture(HISTORY_LENGTH, "first-frame"),
    hasMore: false,
  });
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

/* Reads each frame after its layout has settled: a resize observer created in
   the frame runs after the app's own, which is what the frame then paints. */
async function recordFrames(page: Page, openSelector: string) {
  await page.evaluate(({ openSelector, newestRowId }) => {
    const frames: Frame[] = [];
    (window as unknown as { __openFrames: Frame[] }).__openFrames = frames;
    const read = () => {
      const settled = new ResizeObserver(() => {
        settled.disconnect();
        const newest = document.getElementById(newestRowId);
        const shown = newest && getComputedStyle(newest).visibility !== "hidden" && newest.getClientRects().length > 0;
        frames.push({
          open: Boolean(document.querySelector(openSelector)),
          newestTop: shown ? newest.getBoundingClientRect().top : null,
        });
      });
      settled.observe(document.documentElement);
      requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  }, { openSelector, newestRowId: NEWEST_ROW_ID });
}

async function expectNewestMessageInEveryOpenFrame(page: Page) {
  await expect(page.locator(`[id="${NEWEST_ROW_ID}"]`)).toBeVisible();
  await conversationOpened(page);
  // A few frames past the handover, so a late move would be recorded too.
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
  const frames = await page.evaluate(() => (window as unknown as { __openFrames: Frame[] }).__openFrames);
  const open = frames.filter((frame) => frame.open);
  expect(open.length).toBeGreaterThan(0);
  expect(open.filter((frame) => frame.newestTop === null)).toEqual([]);
  const tops = open.map((frame) => frame.newestTop!);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
}

/* Through the mouse: a row is selected on pointer down and redrawn, and a
   locator click would press the new node a second time. */
async function clickConversationRow(page: Page, channelId: string) {
  const box = await page.locator(`[data-channel-row-id="${channelId}"]`).boundingBox();
  if (!box) throw new Error(`${channelId} has no row`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("a conversation slides in over the list with its newest message already in place", async ({ page }) => {
  await openWorkspace(page, "/app/personal-sspaceperso/channels");
  const row = page.locator('[data-mobile-channel-row-id="channel-general"]');
  const back = page.getByRole("button", { name: "Back to channels" });

  // Once from the network, then from what the first visit kept.
  for (const visit of ["first", "again"]) {
    if (visit === "again") await recordFrames(page, ".app-mobile-channel-detail-bar");
    await row.tap();
    await expect(page.locator(`[id="${NEWEST_ROW_ID}"]`)).toBeVisible();
    if (visit === "first") {
      await conversationOpened(page);
      await back.tap();
      await expect(page.locator(".app-mobile-channel-list-pane")).toBeVisible();
    }
  }
  await expectNewestMessageInEveryOpenFrame(page);
});

test.describe("desktop", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("switching to a conversation shows its newest message in the frame that switches", async ({ page }) => {
    await openWorkspace(page, "/app/personal-sspaceperso/channels/general-cchannelgen");
    await expect(page.locator(`[id="${NEWEST_ROW_ID}"]`)).toBeVisible();
    await conversationOpened(page);
    await clickConversationRow(page, "channel-quiet");
    await expect(page.locator('[data-channel-row-id="channel-quiet"].app-channel-row-active')).toBeVisible();

    await recordFrames(page, '[data-channel-row-id="channel-general"].app-channel-row-active');
    await clickConversationRow(page, "channel-general");
    await expectNewestMessageInEveryOpenFrame(page);
  });
});
