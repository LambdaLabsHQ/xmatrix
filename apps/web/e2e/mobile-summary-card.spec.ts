import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_USER_SENDER, openGeneralChannelWithHistory } from "./workspace-fixtures";

/* The mobile channel Summary sits on paper below the fixed-height wood bar:
   edge to edge, square, without a shadow. Its clamp
   once was dead (`block` beat line-clamp's -webkit-box), so a long summary
   was sliced mid-line at a fixed max-height instead of ellipsizing. Both are
   asserted here against the rendered box, because either one regresses
   invisibly in a class-name diff. */

const LONG_SUMMARY = [
  "The team is tracking the wood material rollout, the mirror layout seam, the storage",
  "unification contract, and the remaining follow-ups for read-state truncation, which",
  "together run well past the two lines this card is allowed to show on a phone.",
].join(" ");

test("mobile Summary stays on paper below the bar and ellipsizes at two lines", async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-08-15T12:00:00Z"));
  const channel = {
    ...E2E_CHANNEL,
    summary: LONG_SUMMARY,
    messageCount: 1,
    lastMessageSequence: 1,
    updatedAt: E2E_NOW,
  };
  const history = [{
    messageId: "message-summary-card",
    channelId: E2E_CHANNEL.id,
    sequence: 1,
    body: "Pushed the branch, waiting on CI before I open the PR.",
    sentAt: E2E_NOW,
    from: E2E_USER_SENDER,
  }];

  await openGeneralChannelWithHistory(page, channel, history);

  const card = page.locator(".app-mobile-channel-about");
  await expect(card).toBeVisible();

  // Edge to edge, square, flush under the bar.
  const viewport = page.viewportSize();
  const box = await card.boundingBox();
  const barBox = await page.locator(".app-topbar").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBe(0);
  expect(box!.width).toBe(viewport!.width);
  expect(box!.y).toBeCloseTo(barBox!.y + barBox!.height, 0);
  await expect(card).toHaveCSS("border-bottom-left-radius", "0px");
  await expect(card).toHaveCSS("background-image", "none");
  await expect(card).toHaveCSS("box-shadow", "none");
  await expect(page.locator(".app-topbar")).toHaveCSS("box-shadow", "none");
  // About the conversation, not part of it: its own paper tone, closed by a
  // hairline, so the message stream visibly starts below it.
  await expect(card).toHaveCSS("border-bottom-width", "1px");
  const [bandFill, streamFill] = await Promise.all([card, page.locator(".app-message-surface")]
    .map((locator) => locator.evaluate((element) => getComputedStyle(element).backgroundColor)));
  expect(bandFill).not.toBe(streamFill);

  // Two clamped lines, and the card is tall enough to show both: the dead
  // clamp used to cut the next line in half at the card's bottom edge.
  const summaryText = card.locator("span", { hasText: LONG_SUMMARY.slice(0, 40) }).last();
  await expect(summaryText).toHaveCSS("-webkit-line-clamp", "2");
  // The declaration alone proves nothing: it stays "3" while a competing
  // `display` utility keeps the clamp from running. Measure instead. Two
  // clamped lines at leading-5 are 40px; the dead clamp laid out every line
  // and let the card's max-height slice the next one.
  const textBox = await summaryText.boundingBox();
  expect(textBox!.height).toBeLessThanOrEqual(42);
  expect(textBox!.y + textBox!.height).toBeLessThanOrEqual(box!.y + box!.height + 1);

  // The card's material is a design judgement no assertion captures, so leave
  // a rendered artifact behind the way the composer glass pass does. Wait for
  // the timeline first: the card is judged against the slab it sits on, and an
  // empty chat pane is not that.
  await expect(page.locator(".app-message-timeline").getByText("Pushed the branch")).toBeVisible();
  const shot = testInfo.outputPath("mobile-summary-card.png");
  await page.screenshot({ path: shot, fullPage: false });
  await testInfo.attach("mobile-summary-card", { path: shot, contentType: "image/png" });

  // No SUMMARY eyebrow: the plank is the label, and the text gets the width.
  await expect(card).not.toContainText(/^Summary/u);

  // Still the way into channel details.
  await card.getByRole("button", { name: "Open channel Summary" }).tap();
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
});
