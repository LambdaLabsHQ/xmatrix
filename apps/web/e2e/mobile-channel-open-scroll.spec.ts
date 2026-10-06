import { expect, test, type Page } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_MOBILE_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  E2E_USER_SENDER,
  fixtureJson,
  installWorkspaceStubs,
} from "./workspace-fixtures";

/* Opening a channel on a phone must land on the newest message. The list row
   is the only way in on mobile, so these cases tap the row instead of deep
   linking: a URL load and a tap take different code paths through the mobile
   screen transition. */

test.use(E2E_MOBILE_CONTEXT);

const MESSAGE_COUNT = 40;

const NEWEST_MESSAGE = `Message ${MESSAGE_COUNT}.`;

/** Distance from the newest message; the timeline treats ≤48px as "at the tail". */
const AT_TAIL_PX = 48;

const HISTORY = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
  messageId: `message-open-scroll-${index + 1}`,
  channelId: E2E_CHANNEL.id,
  sequence: index + 1,
  body: `Message ${index + 1}. ${"Filler text for the mobile timeline. ".repeat(2)}`,
  sentAt: new Date(Date.parse(E2E_NOW) + index * 1_000).toISOString(),
  from: E2E_USER_SENDER,
}));

const CHANNEL = {
  ...E2E_CHANNEL,
  messageCount: MESSAGE_COUNT,
  lastMessageSequence: MESSAGE_COUNT,
  updatedAt: E2E_NOW,
};

function timeline(page: Page) {
  return page.locator(".app-message-timeline");
}

async function distanceFromNewestMessage(page: Page) {
  return timeline(page).evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight
  );
}

/** Open the channel the way a phone user does: from the mobile channel list. */
async function openChannelFromMobileList(page: Page) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [CHANNEL] });
  await fixtureJson(
    page,
    "channel-general-history",
    "**/api/xmatrix/channels/channel-general/history**",
    { messages: HISTORY, hasMore: false }
  );
  await page.goto("/app/personal-sspaceperso/channels", { waitUntil: "domcontentloaded" });

  const channelList = page.locator(".app-mobile-channel-list-pane");
  await expect(channelList).toBeVisible();
  await channelList.getByText("general", { exact: true }).first().tap();
  await expect(page.locator(".app-message-row").last()).toContainText(NEWEST_MESSAGE);
}

/**
 * Stand in for an attachment that decodes after the first paint. The newest
 * row is where that hurts: content added above the reader is absorbed by
 * browser scroll anchoring, content added inside the newest message is not —
 * and WebKit, which runs the iOS app, has no scroll anchoring at all.
 */
async function growNewestMessage(page: Page) {
  await timeline(page).evaluate((element) => {
    const rows = element.querySelectorAll(".app-message-row");
    const grower = document.createElement("div");
    grower.style.height = "600px";
    rows[rows.length - 1]?.append(grower);
  });
}

test("tapping a channel row lands on the newest message", async ({ page }) => {
  await openChannelFromMobileList(page);

  await expect(page.locator(".app-message-row").last()).toBeInViewport();
  await expect.poll(() => distanceFromNewestMessage(page)).toBeLessThanOrEqual(AT_TAIL_PX);
});

test("the newest message keeps a visible scroll-end reserve", async ({ page }) => {
  await openChannelFromMobileList(page);

  const tailReserve = await timeline(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    const messages = element.querySelectorAll<HTMLElement>(".app-message-row");
    const newestMessage = messages[messages.length - 1];
    if (!(newestMessage instanceof HTMLElement)) return Number.NEGATIVE_INFINITY;
    return element.getBoundingClientRect().bottom - newestMessage.getBoundingClientRect().bottom;
  });

  expect(tailReserve).toBeGreaterThanOrEqual(64);
});

test("late-loading message media still leaves the timeline at the newest message", async ({ page }) => {
  await openChannelFromMobileList(page);
  await expect.poll(() => distanceFromNewestMessage(page)).toBeLessThanOrEqual(AT_TAIL_PX);

  // Past the settling frames: a landing that only survives a couple of
  // animation frames strands the reader above the newest message.
  await page.waitForTimeout(400);
  await growNewestMessage(page);

  await expect.poll(() => distanceFromNewestMessage(page)).toBeLessThanOrEqual(AT_TAIL_PX);
  await expect(page.locator(".app-message-row").last()).toBeInViewport();
});

test("scrolling back after the channel-open landing survives late growth", async ({ page }) => {
  await openChannelFromMobileList(page);
  await expect.poll(() => distanceFromNewestMessage(page)).toBeLessThanOrEqual(AT_TAIL_PX);
  // The landing is intentionally allowed to finish. The other cases above
  // cover initial placement and late growth while pinned to the newest row.
  await page.waitForTimeout(1300);

  // This project emulates touch: the mouse wheel can be ignored. Deliver the
  // touch intent and the resulting scroll event in order before media grows.
  await timeline(page).evaluate((element) => {
    element.dispatchEvent(new Event("touchstart", { bubbles: true }));
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 900);
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => distanceFromNewestMessage(page)).toBeGreaterThan(AT_TAIL_PX);

  // Late row growth must not yank a reader who has moved away back to the tail.
  await growNewestMessage(page);
  await page.waitForTimeout(300);
  await expect.poll(() => distanceFromNewestMessage(page)).toBeGreaterThan(AT_TAIL_PX);
});
