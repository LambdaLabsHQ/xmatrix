import { expect, test } from "./fixtures";
import { fixtureJson } from "./in-page-api-fixtures";
import { paintedRowMoves, paintedTimelineFrames, recordPaintedTimelineFrames } from "./painted-timeline-frames";
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

/* What the server answers a send with, after `delayMs`: long enough for a spec
   to look at the row while it is still on its way. */
async function answerNextSend(page: Page, sequence: number, body: string, delayMs: number) {
  await fixtureJson(page, `send-held-${sequence}`, "**/api/xmatrix/channels/channel-general/messages",
    { message: {
      messageId: `held-${sequence}`, channelId: E2E_CHANNEL.id, sequence, body,
      sentAt: new Date().toISOString(), from: { ...E2E_USER_SENDER, identityId: "user:e2e-user" },
    } }, { method: "POST", delayMs });
}

/** The newest row's height, whether it starts a sender's turn, and its avatar node. */
async function newestRowShape(page: Page, markAvatar: boolean) {
  return page.locator(".app-message-timeline [data-timeline-rise-row]").last().evaluate((row, mark) => {
    const avatar = row.querySelector<HTMLElement>(".identity-avatar");
    const sameAvatar = avatar?.dataset.pendingAvatar === "kept";
    if (avatar && mark) avatar.dataset.pendingAvatar = "kept";
    return {
      height: Math.round(row.getBoundingClientRect().height),
      header: Boolean(row.querySelector(".app-message-author-name")),
      sameAvatar,
    };
  }, markAvatar);
}

/* The row a send adds is the row the server's copy will be. It used to be
   drawn apart from the sender's turn, with an avatar and a name of its own,
   and without the hover actions beside the name: when the server confirmed it
   the header vanished, the row lost a third of its height or gained four
   pixels, and every message above moved in that frame
   (user 2026-10-10: "我发现发完消息还是会闪烁？"). */
test("a message on its way is drawn as it will be once the server has it", async ({ page }) => {
  await openChannelRecordingRises(page);
  const draft = page.locator("textarea.composer-textarea").first();

  await answerNextSend(page, HISTORY_LENGTH + 1, "First of two", 1_500);
  await draft.fill("First of two");
  await draft.press("Enter");
  const sending = page.locator(".app-message-sending");
  await expect(sending).toHaveCount(1);
  // A send answered at once never shows the mark: it waits before it appears.
  expect(await sending.evaluate((mark) => mark.getAnimations()
    .map((animation) => animation.effect?.getTiming().delay))).toEqual([700]);
  const first = await newestRowShape(page, true);
  expect(first.header).toBe(true);
  await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 1}"]`)).toBeVisible();
  await expect(sending).toHaveCount(0);
  expect(await newestRowShape(page, false)).toEqual({ ...first, sameAvatar: true });

  // Moments later, under the first: no second header, before or after.
  await answerNextSend(page, HISTORY_LENGTH + 2, "Second of two", 1_500);
  await draft.fill("Second of two");
  await draft.press("Enter");
  await expect(sending).toHaveCount(1);
  const second = await newestRowShape(page, false);
  expect(second.header).toBe(false);
  await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 2}"]`)).toBeVisible();
  expect(await newestRowShape(page, false)).toEqual(second);
});

/* A draft of several lines gives its lines back when it is sent: the composer
   shrinks, and the timeline's end comes down with it a frame or two after the
   new row is in. The rows above used to drop by that much in one frame, in the
   middle of their rise. Every move is part of the rise now. */
test("a draft of several lines is sent without the rows above dropping", async ({ page }) => {
  await openChannelRecordingRises(page);
  const body = ["One", "Two", "Three", "Four", "Five"].map((line) => `Line ${line}`).join("\n");
  await answerNextSend(page, HISTORY_LENGTH + 1, body, 150);
  const draft = page.locator("textarea.composer-textarea").first();
  await draft.fill(body);
  await expect(draft).toHaveValue(body);

  await recordPaintedTimelineFrames(page);
  await draft.press("Enter");
  await expect(page.locator(`[id="message:held-${HISTORY_LENGTH + 1}"]`)).toBeInViewport();
  // The rise, and what follows it, has played out.
  await expect.poll(() => page.locator(".app-message-timeline [data-timeline-rise-row]").last()
    .evaluate((row) => row.getAnimations().length)).toBe(0);
  const frames = await paintedTimelineFrames(page);
  expect(paintedRowMoves(frames).filter((move) => move.by > 1)).toEqual([]);
  const above = `message:rise-${HISTORY_LENGTH}`;
  expect(frames[frames.length - 1]!.tops[above]).toBeLessThan(frames[0]!.tops[above]!);
});
