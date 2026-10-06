import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_USER_SENDER,
  openGeneralChannelWithHistory,
} from "./workspace-fixtures";

/* Short messages sent one after another read as lines of one block. The
   header-less rows kept their time in an avatar-wide gutter, hidden until
   hover but still laid out: "1:49 AM" wrapped to two lines there, and an older
   date to three, so every one-line message stood that tall and the block read
   as if it were full of blank lines (user 2026-10-06). */

test.use(E2E_DESKTOP_CONTEXT);

test("one-line messages from the same sender stay one line apart", async ({ page }) => {
  const sentAt = new Date(Date.parse(E2E_NOW) + 12 * 3_600_000).toISOString();
  const from = { ...E2E_USER_SENDER, identityId: "user:e2e-user" };
  const bodies = ["@grok:21:stop", "@grok:22:stop", "这个在我们 pages 里面提到就可以了。"];
  await openGeneralChannelWithHistory(page, {
    ...E2E_CHANNEL,
    messageCount: bodies.length,
    lastMessageSequence: bodies.length,
    updatedAt: E2E_NOW,
  }, bodies.map((body, index) => ({
    messageId: `m-${index + 1}`, channelId: E2E_CHANNEL.id, sequence: index + 1, body, sentAt, from,
  })));

  const row = page.locator(".app-message-row").filter({ hasText: "pages 里面提到" });
  const gutter = row.locator(".app-message-continuation-gutter");
  await expect(gutter).toHaveCount(1);
  const body = row.locator(".rich-message");
  const [rowBox, bodyBox, gutterBox] = await Promise.all([row.boundingBox(), body.boundingBox(), gutter.boundingBox()]);
  expect(gutterBox!.height).toBeLessThanOrEqual(bodyBox!.height);
  expect(rowBox!.height).toBeLessThanOrEqual(bodyBox!.height + 8);

  // On hover the time shows on one line, without the day the header already says.
  await row.hover();
  const time = gutter.locator("time");
  await expect(time).toBeVisible();
  await expect(time).not.toContainText("/");
  const timeBox = (await time.boundingBox())!;
  expect(timeBox.height).toBeLessThanOrEqual(bodyBox!.height);
  expect(timeBox.x).toBeGreaterThanOrEqual(rowBox!.x);
});

/* Every gap inside one sender's run is the same, and a new sender opens with a
   little more room (user 2026-10-06: the gap after the first message was wider
   than the rest, then "两个人之间的消息间距就稍微要拉大一点"). */
test("one sender's lines sit at one pitch and a new sender opens wider", async ({ page }) => {
  const a = { ...E2E_USER_SENDER, identityId: "user:someone-else", userId: "someone-else" };
  const b = { ...E2E_USER_SENDER, identityId: "user:other", userId: "other", label: "Other Person" };
  const senders = [a, a, a, b, b];
  await openGeneralChannelWithHistory(page, {
    ...E2E_CHANNEL,
    messageCount: senders.length,
    lastMessageSequence: senders.length,
    updatedAt: E2E_NOW,
  }, senders.map((from, index) => ({
    messageId: `m-${index + 1}`, channelId: E2E_CHANNEL.id, sequence: index + 1, body: `line ${index + 1}`, sentAt: E2E_NOW, from,
  })));
  await expect(page.locator(".app-message-row")).toHaveCount(senders.length);

  // Blank between one row's text and the next row's first ink (avatar, header or text).
  const gaps = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".app-message-row"));
    const spans = rows.map((row) => {
      const ink = [".app-message-author-avatar", ".app-message-meta", ".rich-message"]
        .map((selector) => row.querySelector<HTMLElement>(selector))
        .filter((element): element is HTMLElement => element !== null)
        .map((element) => element.getBoundingClientRect());
      return { top: Math.min(...ink.map((box) => box.top)), bottom: row.querySelector<HTMLElement>(".rich-message")!.getBoundingClientRect().bottom };
    });
    return spans.slice(1).map((span, index) => Math.round(span.top - spans[index].bottom));
  });
  const [first, second, newSender, sameAgain] = gaps;
  expect(first).toBe(second);
  expect(sameAgain).toBe(first);
  expect(newSender).toBeGreaterThan(first + 4);
});
