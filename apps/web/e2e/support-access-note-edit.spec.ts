import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const GRANT = "grant-e2e-support";
const FIRST_NOTE = "xMatrix support read this conversation (2026-07-01 00:01 UTC).";
const THIRD_NOTE = "xMatrix support read this conversation 3 times (latest 00:09 UTC).";
const hubWritten = { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true };

/* The Hub edits the hour's support access note in place as support reads
   again (#2093). The person's open conversation showed the first note's text
   and its handoff card stayed at "1 read" (beta 2026-11-24): an edit never
   reached the Web. It now arrives as a live update and the card follows it. */
test("an edited support access note updates the conversation and its handoff card's count", async ({ page }) => {
  const [question, receipt, note] = channelHistory(3, "support-note", (row) => `row ${row}`);
  const messages = [
    { ...question, body: "the agent never starts" },
    { ...receipt, body: "You handed this conversation to xMatrix support: messages.",
      metadata: { ...hubWritten, supportHandoff: { grantId: GRANT, spaceId: E2E_SPACE.id, parts: ["messages"],
        expiresAt: "2026-07-08T00:00:00.000Z" } } },
    { ...note, messageId: `support-access:${GRANT}:${E2E_NOW}`, body: FIRST_NOTE,
      metadata: { ...hubWritten, supportAccess: { grantId: GRANT, spaceId: E2E_SPACE.id, readAt: E2E_NOW } } },
  ];
  const handoff = (readCount: number) => ({ handoff: { id: GRANT, spaceId: E2E_SPACE.id, channelId: E2E_CHANNEL.id,
    supportSpaceId: "space-support", supportChannelId: "channel-support", ownerUserId: "e2e-user",
    line: "it never starts", parts: ["messages"], status: "approved", readCount, requestedAt: E2E_NOW,
    expiresAt: "2026-07-08T00:00:00.000Z", viewerRole: "owner" } });
  const handoffRoute = `**/api/xmatrix/spaces/${E2E_SPACE.id}/support-handoffs/${GRANT}`;
  const send = await openWorkingAgentsSpace(page, workingAgentsSpace(1, "support-note"), messages, FIRST_NOTE,
    { fixtures: () => fixtureJson(page, "support-handoff-1", handoffRoute, handoff(1), { method: "GET" }) });
  const timeline = page.locator(".app-message-timeline");
  const card = page.getByTestId("support-handoff-card");
  await expect(card).toContainText("1 read");

  // Two more reads: the Hub counts them and edits the note to say so; its
  // history (the socket's page and the HTTP read alike) reads the edit too.
  await fixtureJson(page, "support-handoff-3", handoffRoute, handoff(3), { method: "GET" });
  const edited = { ...messages[2], body: THIRD_NOTE, editedAt: "2026-07-01T00:09:00.000Z", entityVersion: 3 };
  messages[2] = edited;
  await fixtureJson(page, "support-note-history", "**/api/xmatrix/channels/channel-general/history**",
    { messages, hasMore: false });
  send({ type: "channel_message_updated", channelId: E2E_CHANNEL.id, message: edited });
  await expect(timeline.getByText(THIRD_NOTE)).toBeVisible();
  await expect(timeline.getByText(FIRST_NOTE)).toHaveCount(0);
  await expect(card).toContainText("3 reads");

  // An older edit arriving late never takes the note back.
  send({ type: "channel_message_updated", channelId: E2E_CHANNEL.id,
    message: { ...edited, body: FIRST_NOTE.replace("(", "2 times ("), editedAt: "2026-07-01T00:05:00.000Z" } });
  await page.waitForTimeout(500);
  await expect(timeline.getByText(THIRD_NOTE)).toBeVisible();

  // Opened again, from its tail cache and history, the note still reads the edit.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-message-timeline").getByText(THIRD_NOTE)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".app-message-timeline").getByText(FIRST_NOTE)).toHaveCount(0);
  await expect(page.getByTestId("support-handoff-card")).toContainText("3 reads");
});
