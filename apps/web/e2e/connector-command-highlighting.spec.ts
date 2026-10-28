import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_USER_SENDER, openGeneralChannelWithHistory } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

// Execution reads the original statement. Markdown must not split its mailbox,
// URL or formatting punctuation before the command's presentation can claim it.
test("connector statements keep their complete literal command through Markdown rendering", async ({ page }) => {
  const commands = [
    "@gmail:search:user@example.com newer_than:45d (from:cursor.com OR from:grok.com OR from:x.ai OR from:stripe.com OR from:email.grok.com) -subject:verification -subject:code",
    "@notion:read_page:https://www.notion.so/my_page_123",
    "@github:comment:owner/my_repo#7 😀 **literal** `code` &amp; [label](https://example.com)",
  ];
  const bodies = [
    ...commands.map(command => `${command}\n\nFollowing **prose** https://example.org/docs\n\n${command}`),
    `> ${commands[0]}`,
    `\`${commands[0]}\``,
    commands[0],
  ];
  await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, messageCount: bodies.length,
    lastMessageSequence: bodies.length, historyHeadSequence: bodies.length, updatedAt: E2E_NOW },
  bodies.map((body, index) => ({ messageId: `command-${index}`, channelId: E2E_CHANNEL.id,
    sequence: index + 1, body, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    ...(index === bodies.length - 1 ? { editedAt: E2E_NOW } : {}) })));

  for (const [index, command] of commands.entries()) {
    const message = page.locator(`[id="message:command-${index}"]`);
    await message.scrollIntoViewIfNeeded();
    const chip = message.locator(".app-connector-command-chip");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText(command);
    await expect(chip.locator("a, strong, code")).toHaveCount(0);
    await expect(message.locator("strong").filter({ hasText: "prose" })).toHaveText("prose");
    await expect(message.getByRole("link", { name: "https://example.org/docs", exact: true })).toHaveAttribute("href", "https://example.org/docs");
  }
  for (const index of [3, 4, 5]) {
    const message = page.locator(`[id="message:command-${index}"]`);
    await message.scrollIntoViewIfNeeded();
    await expect(message.locator(".app-connector-command-chip")).toHaveCount(0);
  }
  await page.locator('[id="message:command-0"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("connector-command-highlighting.png") });
});

test("a folded connector statement expands to one complete chip on a phone", async ({ page }) => {
  const command = `@gmail:search:user@example.com ${"subject:invoice ".repeat(450)}`.trimEnd();
  await page.setViewportSize({ width: 393, height: 852 });
  await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, messageCount: 1,
    lastMessageSequence: 1, historyHeadSequence: 1, updatedAt: E2E_NOW }, [
    { messageId: "folded-command", channelId: E2E_CHANNEL.id, sequence: 1, body: command,
      sentAt: E2E_NOW, from: E2E_USER_SENDER },
  ]);
  const chip = page.locator(".app-connector-command-chip");
  await expect(chip).toHaveCount(1);
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(chip).toHaveText(command);
  expect(await chip.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
