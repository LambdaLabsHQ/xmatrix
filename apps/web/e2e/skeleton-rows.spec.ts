import { expect, test, type Locator, type Page } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_MOBILE_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  E2E_USER_SENDER,
  fixtureRequests,
  fixtureRule,
  installWorkspaceStubs,
  releaseFixture,
} from "./workspace-fixtures";

const SLOW_HISTORY_RULE = "slow-channel-general-history";
const HELD_CATALOG_RULE = "held-channel-catalog";

type Box = { left: number; top: number; width: number; height: number };

function box(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
}

/** A skeleton's bar sits inside the line the text will; this is that line's box. */
function lineOf(bar: Locator): Promise<Box> {
  return box(bar.locator("xpath=.."));
}

/* A list that ends at the composer is placed by its scroll offset, which a
   phone rounds to its own pixel: allow that row a pixel, every other half. */
function expectSameBox(actual: Box, expected: Box, tolerance = 0.5) {
  for (const key of ["left", "top", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${key}: ${actual[key]} vs ${expected[key]}`).toBeLessThanOrEqual(tolerance);
  }
}

function history(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `skeleton-message-${index + 1}`,
    channelId: E2E_CHANNEL.id,
    sequence: index + 1,
    body: `Message ${index + 1}.`,
    sentAt: new Date(Date.parse(E2E_NOW) - (count - index) * 600_000).toISOString(),
    from: E2E_USER_SENDER,
  }));
}

async function openSlowHistory(page: Page, device: string, messageCount: number) {
  const channel = { ...E2E_CHANNEL, messageCount, historyHeadSequence: messageCount, updatedAt: E2E_NOW };
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
  /* Held open on purpose: the skeleton only exists while history is still in
     flight. `releaseFixture` lets it land. */
  await fixtureRule(page, {
    id: SLOW_HISTORY_RULE,
    pattern: "**/api/xmatrix/channels/channel-general/history**",
    responder: { kind: "deferred", json: { messages: history(messageCount), hasMore: false } },
  });
  if (device === "mobile") {
    await page.goto("/app/personal-sspaceperso/channels");
    await page.locator('[data-mobile-channel-row-id="channel-general"]').tap();
  } else {
    await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  }
  await expect.poll(async () => (await fixtureRequests(page, SLOW_HISTORY_RULE)).length).toBeGreaterThan(0);
  await expect(page.locator(".app-message-timeline-skeleton")).toBeVisible();
}

/** What a message row places: itself, its avatar, its sender's line and its first line of text. */
async function messageRowBoxes(row: Locator, skeleton: boolean) {
  return {
    row: await box(row),
    avatar: await box(row.locator(".message-author-avatar")),
    name: skeleton
      ? await lineOf(row.locator(".app-message-author-name .app-skeleton-bar"))
      : await box(row.locator(".app-message-author-name")),
    text: skeleton
      ? await lineOf(row.locator(".rich-message p .app-skeleton-bar").first())
      : await box(row.locator(".rich-message p").first()),
  };
}

for (const [device, context] of [["desktop", E2E_DESKTOP_CONTEXT], ["mobile", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(device, () => {
    test.use(context);

    test("a history that fills the screen lands on its skeleton's last row", async ({ page }) => {
      await openSlowHistory(page, device, 40);
      const skeleton = await messageRowBoxes(page.locator(".app-message-skeleton-row").last(), true);

      await releaseFixture(page, SLOW_HISTORY_RULE);
      const last = page.locator(".app-message-timeline .app-message-row", { hasText: "Message 40." });
      await expect(last).toBeVisible();
      await expect(page.locator(".app-message-timeline-skeleton")).toHaveCount(0);
      await expect.poll(async () => Math.abs((await box(last)).top - skeleton.row.top)).toBeLessThanOrEqual(1);

      const message = await messageRowBoxes(last, false);
      expectSameBox(skeleton.row, message.row, 1);
      expectSameBox(skeleton.avatar, message.avatar, 1);
      expect(Math.abs(skeleton.name.left - message.name.left)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(skeleton.name.top - message.name.top)).toBeLessThanOrEqual(1);
      expectSameBox(skeleton.text, message.text, 1);
    });

    test("a history of two messages lands on its skeleton's two rows at the top", async ({ page }) => {
      await openSlowHistory(page, device, 2);
      const skeletonRows = page.locator(".app-message-skeleton-row");
      await expect(skeletonRows).toHaveCount(2);
      const skeleton = [await messageRowBoxes(skeletonRows.nth(0), true), await messageRowBoxes(skeletonRows.nth(1), true)];

      await releaseFixture(page, SLOW_HISTORY_RULE);
      const rows = page.locator(".app-message-timeline .app-message-row");
      await expect(rows.filter({ hasText: "Message 2." })).toBeVisible();
      await expect(page.locator(".app-message-timeline-skeleton")).toHaveCount(0);

      for (const index of [0, 1]) {
        const message = await messageRowBoxes(rows.nth(index), false);
        expectSameBox(skeleton[index].row, message.row);
        expectSameBox(skeleton[index].avatar, message.avatar);
        expectSameBox(skeleton[index].text, message.text);
      }
    });

    test("the conversation list lands on its skeleton's rows", async ({ page }) => {
      const channels = Array.from({ length: 3 }, (_, index) => ({
        ...E2E_CHANNEL,
        id: `channel-skeleton-${index}`,
        name: `skeleton-${index}`,
        updatedAt: E2E_NOW,
        lastMessage: { from: E2E_USER_SENDER, bodyPreview: "What was said last", sentAt: E2E_NOW },
      }));
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels });
      /* Held open on purpose: the list's skeleton only exists while its first
         catalog page is still in flight. */
      await fixtureRule(page, {
        id: HELD_CATALOG_RULE,
        pattern: /\/api\/xmatrix\/channels\/(?:page|resolve)(?:\?.*)?$/,
        responder: { kind: "channelCatalog", channels, held: true },
      });
      await page.goto("/app/personal-sspaceperso/channels", { waitUntil: "domcontentloaded" });

      const list = page.getByRole("status", { name: "Loading channels" }).locator("visible=true");
      await expect(list).toBeVisible();
      const skeletonRows = list.locator(".app-channel-chat-row");
      const placed = async (row: Locator, skeleton: boolean) => ({
        row: await box(row),
        hash: await box(row.locator(".app-channel-row-hash")),
        name: skeleton ? await lineOf(row.locator(".app-channel-row-name .app-skeleton-bar")) : await box(row.locator(".app-channel-row-name")),
        preview: skeleton
          ? await lineOf(row.locator(".app-channel-row-preview .app-skeleton-bar"))
          : await box(row.locator(".app-channel-row-preview")),
      });
      const skeleton = [await placed(skeletonRows.nth(0), true), await placed(skeletonRows.nth(2), true)];
      const skeletonHeading = await box(list.locator(".app-list-section-label"));

      await releaseFixture(page, HELD_CATALOG_RULE);
      const rows = page.locator(".app-channel-chat-row:visible");
      await expect(rows.filter({ hasText: "skeleton-0" })).toBeVisible();
      await expect(list).toHaveCount(0);

      expectSameBox(skeletonHeading, await box(page.locator(".app-list-section-label:visible").first()));
      for (const [at, index] of [[0, 0], [1, 2]] as const) {
        const row = await placed(rows.nth(index), false);
        expectSameBox(skeleton[at].row, row.row);
        expectSameBox(skeleton[at].hash, row.hash);
        expect(Math.abs(skeleton[at].name.left - row.name.left)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(skeleton[at].name.top - row.name.top)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(skeleton[at].preview.left - row.preview.left)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(skeleton[at].preview.top - row.preview.top)).toBeLessThanOrEqual(0.5);
      }
    });
  });
}
