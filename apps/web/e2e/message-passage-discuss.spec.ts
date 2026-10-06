import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_USER_SENDER, E2E_NOW, openGeneralChannelWithHistory } from "./workspace-fixtures";
import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

// Selecting a passage of a message starts a conversation about it, as a selected passage of a page does.
test("selecting a passage of a message starts a conversation holding it, linked to the same pages", async ({ page }) => {
  const message = { messageId: "m-relay", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    body: "The relay stalls when the queue fills. Retries back off too slowly." };
  const created = { ...E2E_CHANNEL, id: "c-passage", name: "“Retries back off too slowly.”" };
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, [message], [created]);
  await fixtureJson(page, "conversation-create", /\/api\/xmatrix\/channels$/u, { channel: created }, { method: "POST" });
  await fixtureJson(page, "source-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?conversationId=channel-general$/u, {
    links: [{ linkId: "l1", conversationId: E2E_CHANNEL.id, pageId: "p-relay", blockId: "status", source: "edit",
      createdAt: E2E_NOW, lastSeenAt: E2E_NOW, anchor: null, resolvedAt: null }] });
  await fixtureJson(page, "link-create", /\/api\/xmatrix\/spaces\/[^/]+\/page-links$/u, { link: {} }, { method: "POST" });

  const text = page.locator("[data-message-body='m-relay']");
  await expect(text).toContainText("Retries back off");
  // Virtuoso keeps a row hidden briefly after it measures it; hidden text selects as nothing.
  await expect(text).toBeVisible();
  // Select the second sentence of the message.
  await text.evaluate((body) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf("Retries");
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, node.textContent!.length);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      return;
    }
  });
  const menu = page.getByTestId("message-selection-menu");
  await expect(menu.getByRole("button", { name: "Discuss" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("message-selection-menu.png") });
  await menu.getByRole("button", { name: "Discuss" }).click();

  await expect.poll(() => fixtureRequestBodies(page, "conversation-create")).toEqual([expect.objectContaining({
    spaceId: E2E_SPACE.id, name: "“Retries back off too slowly.”", mode: "open",
    metadata: { createdBy: "web", fromChannelId: E2E_CHANNEL.id, fromMessageId: "m-relay" },
  })]);
  await expect.poll(() => fixtureRequestBodies(page, "link-create")).toEqual([
    { conversationId: "c-passage", pageId: "p-relay", blockId: "status", source: "manual" }]);
  await expect(page).toHaveURL(/c-passage/u);
  const composer = page.locator("textarea.composer-textarea").first();
  await expect(composer).toHaveValue(/^> Retries back off too slowly\.\n\n— \[E2E Tester in #general\]\(http:\/\/[^)]+\/channels\/[^)]+#message:m-relay\)\n\n$/u);
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
