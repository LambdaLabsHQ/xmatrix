import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_USER_SENDER, E2E_NOW, openGeneralChannelWithHistory } from "./workspace-fixtures";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import { CREATED_CHANNEL_ID, fixtureChannelCreate, fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";
import { expectDraft } from "./composer-draft";

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

// Quoting a passage of a message puts it above this conversation's composer; the next message sent carries it.
test("quoting a passage of a message holds it in this conversation's composer", async ({ page }) => {
  const message = { messageId: "m-relay", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    body: "The relay stalls when the queue fills. Retries back off too slowly." };
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, [message]);
  const text = page.locator("[data-message-body='m-relay']");
  await expect(text).toBeVisible();
  await selectFrom(text, "Retries");
  const menu = page.getByTestId("message-selection-menu");
  await menu.getByRole("button", { name: "Quote" }).click();

  const quote = page.getByTestId("composer-quote");
  await expect(quote).toContainText("Retries back off too slowly.");
  await expect(quote).toContainText("E2E Tester in #general");
  await expect(page).not.toHaveURL(new RegExp(`--${CREATED_CHANNEL_ID}`, "u"));
  await expect(page.locator(".composer-textarea").first()).toBeFocused();
  await expect(menu).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("message-passage-quoted.png") });
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
  await expectDraft(composer, /^\u200B?$/u);
  const quote = page.getByTestId("composer-quote");
  await expect(quote).toContainText("Retries back off too slowly.");
  await expect(quote).toContainText("E2E Tester in #general");
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

// A message carrying a quoted passage shows it as one paper slip: the words, then where they came from, which links back.
test("a quoted passage shows as one slip with its source inside it", async ({ page }) => {
  const message = { messageId: "m-quoted", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    body: "> 我们的成本几乎都花在\"在线\"上\n\n— [claude:1 in #xMatrix 免费与付费模式重新设计](https://xmatrix.sh/app/s/channels/c#message:m1)\n\n那就先把在线成本拆开看。" };
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, [message]);
  const citation = page.locator("[data-message-body='m-quoted'] .message-citation");
  await expect(citation.locator("blockquote")).toHaveText("我们的成本几乎都花在\"在线\"上");
  await expect(citation.getByRole("link", { name: "claude:1 in #xMatrix 免费与付费模式重新设计" }))
    .toHaveAttribute("href", "https://xmatrix.sh/app/s/channels/c#message:m1");
  await expect(page.locator("[data-message-body='m-quoted']")).not.toContainText("—");
  await expect(page.locator("[data-message-body='m-quoted']")).toContainText("那就先把在线成本拆开看。");
  await page.locator("[data-message-body='m-quoted']").screenshot({ path: test.info().outputPath("message-citation.png") });
});
