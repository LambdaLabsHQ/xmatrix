import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_USER_SENDER, E2E_NOW, openGeneralChannelWithHistory } from "./workspace-fixtures";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import { CREATED_CHANNEL_ID, fixtureChannelCreate, fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";
import { draftValue, expectDraft } from "./composer-draft";

test.use(E2E_DESKTOP_CONTEXT);

/**
 * Selects a message's text from the first occurrence of `start` to the end of
 * that text node, until the selection menu shows: a row the list re-renders
 * while it settles drops a selection made in it.
 */
async function selectFrom(text: Locator, start: string) {
  await expect(async () => {
    await selectOnce(text, start);
    await expect(text.page().getByTestId("message-selection-menu")).toBeVisible({ timeout: 1000 });
  }).toPass();
}

/** The composer's text with the box around it, for a screenshot. */
async function around(element: Locator) {
  const box = (await element.boundingBox())!;
  return { x: box.x - 48, y: box.y - 16, width: box.width + 120, height: box.height + 32 };
}

async function selectOnce(text: Locator, start: string) {
  await text.evaluate((body, start) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(start);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, node.textContent!.length);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      return;
    }
  }, start);
}

// Quoting passages of messages puts each into the draft as a block where the caret is, among what is written, in
// order; the message sent is that draft.
test("quoting passages of messages puts each into this conversation's draft as a block, in order", async ({ page }) => {
  const message = { messageId: "m-relay", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    body: "The relay stalls when the queue fills. Retries back off too slowly." };
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, [message]);
  const text = page.locator("[data-message-body='m-relay']");
  await expect(text).toBeVisible();
  const menu = page.getByTestId("message-selection-menu");
  const composer = page.locator(".composer-textarea").first();
  await selectFrom(text, "Retries");
  await menu.getByRole("button", { name: "Quote" }).click();
  await expect(composer).toBeFocused();
  await expect(menu).toBeHidden();
  await page.keyboard.type("Why so slow?");
  await page.keyboard.press("Shift+Enter");
  await selectFrom(text, "The relay");
  await menu.getByRole("button", { name: "Quote" }).click();
  await page.keyboard.type("And this?");

  const quotes = page.getByTestId("composer-quote");
  await expect(quotes).toHaveCount(2);
  await expect(quotes.nth(0)).toContainText("Retries back off too slowly.");
  await expect(quotes.nth(1)).toContainText("The relay stalls when the queue fills. Retries back off too slowly.");
  // A quote of this conversation is its own reference: no line naming the conversation it is already in.
  await expect(quotes.nth(0)).not.toContainText("#general");
  const link = (await draftValue(composer))!.match(/\]\(([^)]+)\)/u)![1]!;
  await expectDraft(composer, `> Retries back off too slowly.\n\n— [E2E Tester in #general](${link})\n\nWhy so slow?\n`
    + `> The relay stalls when the queue fills. Retries back off too slowly.\n\n— [E2E Tester in #general](${link})\n\nAnd this?`);
  await expect(page).not.toHaveURL(new RegExp(`--${CREATED_CHANNEL_ID}`, "u"));
  await page.screenshot({ path: test.info().outputPath("composer-quotes.png"),
    clip: await around(composer) });

  // Backspace at the start of the line after a quote takes the quote whole.
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect(quotes).toHaveCount(1);
  await expectDraft(composer, `> Retries back off too slowly.\n\n— [E2E Tester in #general](${link})\n\nWhy so slow?\nAnd this?`);
  // Its × does too.
  await quotes.first().getByRole("button", { name: "Remove quote" }).click();
  await expectDraft(composer, "Why so slow?\nAnd this?");
});

// A message shows each passage it quotes as its own slip where it was put, in order among what was written.
test("a message quoting several passages shows each as a slip in place", async ({ page }) => {
  const href = "https://xmatrix.sh/app/s/channels/c#message:m1";
  const message = { messageId: "m-quoting", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    body: `先看这句：\n> 第一段引文\n\n— [claude:1 in #other](${href})\n\n中间的话\n> 第二段引文\n\n— [codex in #other](${href})\n\n最后的话` };
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, [message]);
  const body = page.locator("[data-message-body='m-quoting']");
  await expect(body.locator(".message-citation")).toHaveCount(2);
  const order = await body.locator(".rich-message > *").allInnerTexts();
  expect(order.map((value) => value.trim().split("\n")[0])).toEqual(["先看这句：", "第一段引文", "中间的话", "第二段引文", "最后的话"]);
  await expect(body).not.toContainText("—");
  await body.screenshot({ path: test.info().outputPath("message-quotes.png") });
});

// Selecting a passage of a message starts a conversation about it, as a selected passage of a page does.
test("selecting a passage of a message starts a conversation holding it, linked to the same pages", async ({ page }) => {
  const message = { messageId: "m-relay", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    body: "The relay stalls when the queue fills. Retries back off too slowly." };
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, [message]);
  await fixtureChannelCreate(page, "conversation-create", { ...E2E_CHANNEL, name: "“Retries back off too slowly.”" });
  await fixtureJson(page, "source-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?conversationId=channel-general$/u, {
    links: [{ linkId: "l1", conversationId: E2E_CHANNEL.id, pageId: "p-relay", blockId: "status", source: "edit",
      createdAt: E2E_NOW, lastSeenAt: E2E_NOW, anchor: null, resolvedAt: null }] });
  await fixtureJson(page, "link-create", /\/api\/xmatrix\/spaces\/[^/]+\/page-links$/u, { link: {} }, { method: "POST" });

  const text = page.locator("[data-message-body='m-relay']");
  await expect(text).toContainText("Retries back off");
  // Virtuoso keeps a row hidden briefly after it measures it; hidden text selects as nothing.
  await expect(text).toBeVisible();
  // Select the second sentence of the message.
  await selectFrom(text, "Retries");
  const menu = page.getByTestId("message-selection-menu");
  await expect(menu.getByRole("button", { name: "Quote" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Discuss in new channel" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("message-selection-menu.png") });
  await menu.getByRole("button", { name: "Discuss in new channel" }).click();

  await expect.poll(() => fixtureRequestBodies(page, "conversation-create")).toEqual([expect.objectContaining({
    spaceId: E2E_SPACE.id, name: "“Retries back off too slowly.”", mode: "open",
    // Named by the passage only until its first message says something (#870).
    metadata: { createdBy: "web", fromChannelId: E2E_CHANNEL.id, fromMessageId: "m-relay", autoName: true },
  })]);
  const createdId = new RegExp(`^${CREATED_CHANNEL_ID}$`, "u");
  await expect.poll(() => fixtureRequestBodies(page, "link-create")).toEqual([
    { conversationId: expect.stringMatching(createdId), pageId: "p-relay", blockId: "status", source: "manual" }]);
  await expect(page).toHaveURL(new RegExp(`--${CREATED_CHANNEL_ID}`, "u"));
  const composer = page.locator(".composer-textarea").first();
  // Its draft opens holding the passage as its first block, to write after.
  await expectDraft(composer, /^> Retries back off too slowly\.\n\n— \[E2E Tester in #general\]\([^)]+#message:m-relay\)\n\n$/u);
  const quote = page.getByTestId("composer-quote");
  await expect(quote).toContainText("Retries back off too slowly.");
  await expect(quote).toContainText("E2E Tester in #general");
  await page.screenshot({ path: test.info().outputPath("composer-quote-elsewhere.png"),
    clip: await around(composer) });
  await expect(composer).toBeFocused();
  await expect(menu).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("message-passage-conversation.png") });
});

test("a selection across two messages offers nothing", async ({ page }) => {
  const messages = ["First message here.", "Second message here."].map((body, index) => ({
    messageId: `m-${index}`, channelId: E2E_CHANNEL.id, sequence: index + 1, sentAt: E2E_NOW, from: E2E_USER_SENDER, body }));
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, messages);
  await expect(page.locator("[data-message-body='m-1']")).toContainText("Second");
  await expect(page.locator("[data-message-body='m-1']")).toBeVisible();
  await page.evaluate(() => {
    const range = document.createRange();
    range.setStart(document.querySelector("[data-message-body='m-0']")!, 0);
    range.setEnd(document.querySelector("[data-message-body='m-1']")!, 1);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });
  await page.waitForTimeout(200);
  await expect(page.getByTestId("message-selection-menu")).toHaveCount(0);
});

// A passage quoted from another conversation shows as one paper slip: the words, then where they came from, which links back.
test("a passage quoted from elsewhere shows as one slip with its source inside it", async ({ page }) => {
  const message = { messageId: "m-quoted", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    body: "> 我们的成本几乎都花在\"在线\"上\n\n— [claude:1 in #xMatrix 免费与付费模式重新设计](https://xmatrix.sh/app/s/channels/c#message:m1)\n\n那就先把在线成本拆开看。" };
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, [message]);
  const body = page.locator("[data-message-body='m-quoted']");
  const citation = body.locator(".message-citation");
  await expect(citation.locator("blockquote")).toHaveText("我们的成本几乎都花在\"在线\"上");
  await expect(citation.getByRole("link", { name: "claude:1 in #xMatrix 免费与付费模式重新设计" }))
    .toHaveAttribute("href", "https://xmatrix.sh/app/s/channels/c#message:m1");
  await expect(body).not.toContainText("—");
  await expect(body).toContainText("那就先把在线成本拆开看。");
  await body.screenshot({ path: test.info().outputPath("message-citation-elsewhere.png") });
});

// A passage quoted from this conversation is its own reference: the slip alone opens its message with the words marked.
test("a passage quoted from this conversation opens its message with the words marked", async ({ page }) => {
  const original = { messageId: "m-cost", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    body: "先说结论。我们的成本几乎都花在\"在线\"上，存储和流量都很便宜。" };
  // Written on another host than the one reading it, as a quote made on xmatrix.sh is read on beta or the desktop app.
  const quoting = { messageId: "m-quoted", channelId: E2E_CHANNEL.id, sequence: 2, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    body: `> 我们的成本几乎都花在"在线"上\n\n— [E2E Tester in #general](https://xmatrix.sh/app/${E2E_SPACE.id}/channels/${E2E_CHANNEL.id}#message:m-cost)\n\n那就先把在线成本拆开看。` };
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, [original, quoting]);
  const body = page.locator("[data-message-body='m-quoted']");
  const citation = body.getByRole("button", { name: "我们的成本几乎都花在\"在线\"上" });
  await expect(citation).toBeVisible();
  await expect(body).not.toContainText("#general");
  await expect(body).not.toContainText("E2E Tester");
  await body.screenshot({ path: test.info().outputPath("message-citation-here.png") });
  await citation.click();
  await expect(page.locator(".message-jump-highlight [data-message-body='m-cost']")).toBeVisible();
  await expect.poll(() => page.evaluate(() => CSS.highlights.get("cited-passage")?.values().next().value?.toString()))
    .toBe("我们的成本几乎都花在\"在线\"上");
  await page.mouse.move(0, 0);
  await page.locator(".message-jump-highlight").screenshot({ path: test.info().outputPath("message-citation-landed.png") });
});
