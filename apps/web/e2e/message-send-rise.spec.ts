import { expect, test } from "./fixtures";
import { fixtureJson } from "./in-page-api-fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_USER_SENDER,
  channelHistoryFixture,
  conversationOpened,
  openGeneralChannelWithHistory,
} from "./workspace-fixtures";

/* Sending a message used to move the whole timeline in one frame. The new row
   now rises out of the composer and the rows above rise with it, the way a
   chat app's list moves on send (user 2026-10-10: "发送消息的时候，我们有个上浮动画，
   就像微信一样吧"). The motion is over in a quarter of a second, so the spec reads
   the animations the page started rather than sampling positions mid-flight. */

test.use(E2E_DESKTOP_CONTEXT);

type Page = Parameters<Parameters<typeof test>[2]>[0]["page"];
type Rise = { sent: boolean; fromPx: number; fades: boolean };

const HISTORY_LENGTH = 40;
const SENT_BODY = "Rising message";

async function openChannelRecordingRises(page: Page) {
  await page.addInitScript(() => {
    const rises: Rise[] = [];
    (window as unknown as { __timelineRises: Rise[] }).__timelineRises = rises;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function recordRise(this: Element, keyframes, options) {
      const kind = this.getAttribute("data-timeline-rise-row");
      const first = Array.isArray(keyframes) ? keyframes[0] : undefined;
      const from = /translateY\(([\d.]+)px\)/u.exec(String(first?.transform ?? ""));
      if (kind !== null && from) {
        rises.push({ sent: kind === "sent", fromPx: Number(from[1]), fades: first?.opacity === 0 });
      }
      return animate.call(this, keyframes, options);
    };
  });
  const channel = { ...E2E_CHANNEL, updatedAt: E2E_NOW, messageCount: HISTORY_LENGTH, lastMessageSequence: HISTORY_LENGTH };
  await openGeneralChannelWithHistory(page, channel, channelHistoryFixture(HISTORY_LENGTH, "rise"));
  await fixtureJson(page, "send-rise", "**/api/xmatrix/channels/channel-general/messages",
    { message: {
      messageId: "sent-rise", channelId: E2E_CHANNEL.id, sequence: HISTORY_LENGTH + 1, body: SENT_BODY,
      sentAt: new Date().toISOString(), from: { ...E2E_USER_SENDER, identityId: "user:e2e-user" },
    } }, { method: "POST" });
  await expect(page.locator(".app-message-row").filter({ hasText: `Message ${HISTORY_LENGTH}.` })).toBeVisible();
  await conversationOpened(page);
}

async function sendAndReadRises(page: Page): Promise<Rise[]> {
  const draft = page.locator("textarea.composer-textarea").first();
  await draft.fill(SENT_BODY);
  await draft.press("Enter");
  await expect(page.locator(".app-message-row").filter({ hasText: SENT_BODY })).toBeInViewport();
  return page.evaluate(() => (window as unknown as { __timelineRises: Rise[] }).__timelineRises);
}

test("a sent message rises from the composer and lifts the rows above it", async ({ page }) => {
  await openChannelRecordingRises(page);
  const rises = await sendAndReadRises(page);

  const sent = rises.filter((rise) => rise.sent);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.fades).toBe(true);
  expect(sent[0]!.fromPx).toBeGreaterThan(0);

  // The rows above travel the room the new row took: together, and no further
  // than the new row itself.
  const above = rises.filter((rise) => !rise.sent);
  expect(above.length).toBeGreaterThan(0);
  expect(new Set(above.map((rise) => rise.fromPx)).size).toBe(1);
  expect(above[0]!.fromPx).toBeGreaterThan(0);
  expect(above[0]!.fromPx).toBeLessThanOrEqual(sent[0]!.fromPx);
  expect(above.every((rise) => !rise.fades)).toBe(true);
});

test("a sent message lands without motion when the reader asked for less of it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openChannelRecordingRises(page);
  expect(await sendAndReadRises(page)).toEqual([]);
});
