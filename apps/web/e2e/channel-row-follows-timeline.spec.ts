import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

/* A Channel snapshot (an Agent's status report, a catalog read) can name a
   newer last message than the open timeline has received. The list showed it
   first and the conversation a moment later (user 2026-10-14: "列表最新消息和
   频道内部消息没统一显示……现在是列表明显先于频道内部收到"). The open
   conversation's row now shows a message in the same frame as its timeline. */
test("the open conversation's row shows a new message in the frame its timeline does", async ({ page }) => {
  const space = workingAgentsSpace(1, "row-follows", { intent: "Report" });
  const send = await openWorkingAgentsSpace(page, space,
    channelHistory(40, "row-follows-history", (row) => `History row ${row}`), "History row 40");
  const row = page.locator(`[data-channel-row-id="${E2E_CHANNEL.id}"]`);
  await expect(row).toContainText("History row 40");

  const body = "The report, just in";
  // Row 41 of the same history: the next message, as the Hub frames it.
  const message = channelHistory(41, "row-follows-history", () => body).at(-1)!;
  // The Agent's status report carries the Channel as the Hub has it, message included.
  const [, reported] = space.report(0, "Reported");
  send({ ...reported, channel: {
    ...(reported as { channel: object }).channel,
    messageCount: 41, historyHeadSequence: 41, lastMessageSequence: 41, updatedAt: message.sentAt,
    lastMessage: { messageId: message.messageId, from: message.from, bodyPreview: body, sentAt: message.sentAt },
  } });
  await page.waitForTimeout(1_000);
  await expect(page.locator(".app-message-timeline").getByText(body)).toHaveCount(0);
  await expect(row).not.toContainText(body);
  await expect(row).toContainText("History row 40");

  // Every frame from here on: when the row and the timeline first show it.
  await page.evaluate(([text, channelId]) => {
    const seen: { row?: number; timeline?: number; frame: number } = { frame: 0 };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    const tick = () => {
      seen.frame += 1;
      const listed = document.querySelector(`[data-channel-row-id="${channelId}"]`)?.textContent?.includes(text);
      const shown = Array.from(document.querySelectorAll(".app-message-timeline .app-message-row"))
        .some((entry) => entry.textContent?.includes(text));
      if (listed && seen.row === undefined) seen.row = seen.frame;
      if (shown && seen.timeline === undefined) seen.timeline = seen.frame;
      if (seen.row === undefined || seen.timeline === undefined) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [body, E2E_CHANNEL.id]);
  send({ type: "channel_message_received", message });
  await expect(row).toContainText(body);
  await expect(page.locator(".app-message-timeline").getByText(body)).toBeVisible();
  const seen = await page.evaluate(() => (window as unknown as { __seen: { row?: number; timeline?: number } }).__seen);
  expect(seen.row).toBeDefined();
  expect(seen.row).toBe(seen.timeline);
});
