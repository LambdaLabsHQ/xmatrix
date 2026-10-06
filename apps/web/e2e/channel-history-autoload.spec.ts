import { expect, test, type Page } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  E2E_USER_SENDER,
  channelHistoryFixture,
  installWorkspaceStubs,
  openGeneralChannelWithPagedHistory,
  requestedHistoryCursors,
  sparseHeadChannelHistory,
  fixtureRequests,
  fixtureRule,
  releaseFixture,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const MESSAGE_COUNT = 56;
const HISTORY = channelHistoryFixture(MESSAGE_COUNT, "message-autoload");
const SLOW_HISTORY_RULE = "slow-channel-general-history";

async function loadOlderHistoryPage(
  page: Page,
  beforeSequence: number,
  remainingScrollOffset = 0,
) {
  const timeline = page.locator(".app-message-timeline");
  const { clientHeight, scrollHeight } = await timeline.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  await timeline.hover();
  await page.mouse.wheel(0, -Math.max(1, scrollHeight - clientHeight - remainingScrollOffset));
  await expect
    .poll(async () => (await requestedHistoryCursors(page)).includes(beforeSequence))
    .toBe(true);
}

test("a slow desktop history load shows animated progress and the channel message count", async ({ page }) => {
  const messageCount = 12_480;
  const channel = {
    ...E2E_CHANNEL,
    messageCount,
    historyHeadSequence: messageCount,
    updatedAt: E2E_NOW,
  };
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
  /* Held open on purpose: the loading state only exists while the request is
     still outstanding. `releaseFixture` below lets it finish. */
  await fixtureRule(page, {
    id: SLOW_HISTORY_RULE,
    pattern: "**/api/xmatrix/channels/channel-general/history**",
    responder: {
      kind: "deferred",
      json: {
        messages: [{
          messageId: "message-slow-history",
          channelId: E2E_CHANNEL.id,
          sequence: messageCount,
          body: "The slow history request completed.",
          sentAt: E2E_NOW,
          from: E2E_USER_SENDER,
        }],
        hasMore: false,
      },
    },
  });

  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", {
    waitUntil: "domcontentloaded",
  });
  // The fixture answers inside the page, so the request never reaches the
  // network: wait on the fixture's own log rather than on page.waitForRequest.
  await expect
    .poll(async () => (await fixtureRequests(page, SLOW_HISTORY_RULE)).length)
    .toBeGreaterThan(0);

  const loadingStatus = page.getByRole("status", {
    name: "Loading history for 12,480 messages",
  });
  await expect(loadingStatus).toBeVisible();
  await expect(loadingStatus.locator(".app-message-skeleton-row").first()).toBeVisible();
  await expect(loadingStatus.getByText("Loading message history…")).toHaveCount(0);
  await expect(loadingStatus.getByText("12,480 messages in this channel")).toHaveCount(0);
  await expect(loadingStatus.locator(".app-message-loading-spinner")).toHaveCount(0);
  const skeletonLine = loadingStatus.locator(".app-message-skeleton-line").first();
  await expect(skeletonLine).toBeVisible();
  expect(await skeletonLine.evaluate((element) => getComputedStyle(element).animationName)).not.toBe("none");

  await releaseFixture(page, SLOW_HISTORY_RULE);
  await expect(page.getByText("The slow history request completed.")).toBeVisible();
  await expect(loadingStatus).toHaveCount(0);
});

test("scrolling upward automatically loads the complete older history", async ({ page }) => {
  await openGeneralChannelWithPagedHistory(page, HISTORY);

  const timeline = page.locator(".app-message-timeline");
  await expect(page.locator(".app-message-timeline").getByText("Message 56.", { exact: false })).toBeVisible();
  await expect.poll(async () => (await requestedHistoryCursors(page)).includes(null)).toBe(true);

  // The virtualizer's own prefetch viewport must request before the reader
  // hits the exact scroll boundary. That keeps the interaction responsive on
  // desktop wheels and mobile swipe momentum alike.
  await loadOlderHistoryPage(page, 47, 160);
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await timeline.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(page.locator(".app-message-timeline").getByText("Message 1.", { exact: false })).toBeVisible();
  const cursors = await requestedHistoryCursors(page);
  expect(cursors).toContain(47);
  expect(cursors.filter((sequence) => sequence === 47)).toHaveLength(1);
});

test("a short timeline keeps loading older pages through its managed boundary", async ({ page }) => {
  const shortHistory = HISTORY.slice(0, 11);

  await page.setViewportSize({ width: 1280, height: 2_000 });
  await openGeneralChannelWithPagedHistory(page, shortHistory);

  const timeline = page.locator(".app-message-timeline");
  await expect(page.locator(".app-message-timeline").getByText("Message 11.", { exact: false })).toBeVisible();
  await loadOlderHistoryPage(page, 2);
  await timeline.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(page.locator(".app-message-timeline").getByText("Message 1.", { exact: false })).toBeVisible();
  expect(await requestedHistoryCursors(page)).toContain(2);
});

test.describe("mobile channel history", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });

  test("a sparse mobile history page follows the server continuation cursor", async ({ page }) => {
    const channel = {
      ...E2E_CHANNEL,
      messageCount: 11,
      lastMessageSequence: 11,
      updatedAt: E2E_NOW,
    };
    const sparseLatestPage = HISTORY.slice(2, 11);

    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
    await sparseHeadChannelHistory(page, HISTORY, sparseLatestPage);
    await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", {
      waitUntil: "domcontentloaded",
    });

    const timeline = page.locator(".app-message-timeline");
    await expect(timeline.getByText("Message 11.", { exact: false })).toBeVisible();
    await loadOlderHistoryPage(page, 3);

    await timeline.evaluate((element) => element.scrollTo({ top: 0 }));
    await expect(page.locator(".app-message-timeline").getByText("Message 1.", { exact: false })).toBeVisible();
    expect(await requestedHistoryCursors(page)).toContain(3);
  });
});
