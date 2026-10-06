import { expect, test, type Locator } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_MOBILE_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

const mentionedChannel = {
  ...E2E_CHANNEL,
  id: "channel-design",
  name: "design",
  messageCount: 5,
  historyHeadSequence: 5,
  readSequence: 0,
  attention: {
    channelId: "channel-design",
    unreadAttentionCount: 1,
    lastAttentionAt: E2E_NOW,
    lastMessageId: "channel-design-mention",
    lastMessageSequence: 3,
    primaryTriggerKind: "mention",
    triggerKinds: ["mention"],
    updatedAt: E2E_NOW,
  },
};

const replyOnlyChannel = {
  ...E2E_CHANNEL,
  id: "channel-release",
  name: "release",
  messageCount: 4,
  historyHeadSequence: 4,
  readSequence: 0,
  attention: {
    channelId: "channel-release",
    unreadAttentionCount: 1,
    lastAttentionAt: E2E_NOW,
    lastMessageId: "channel-release-reply",
    lastMessageSequence: 2,
    primaryTriggerKind: "reply",
    triggerKinds: ["reply"],
    updatedAt: E2E_NOW,
  },
};

/** The mentioned conversation wears the @ mark, the one with only a reply does not: one mark on a phone and a desktop. */
async function expectMentionMarks(mentioned: Locator, replyOnly: Locator) {
  await expect(mentioned).toBeVisible();
  await expect(mentioned).toHaveAttribute("data-unread-mention", "true");
  await expect(mentioned.getByLabel("Unread mention")).toBeVisible();
  await expect(replyOnly).toBeVisible();
  await expect(replyOnly).not.toHaveAttribute("data-unread-mention", "true");
  await expect(replyOnly.getByLabel("Unread mention")).toHaveCount(0);
}

test.describe("conversation mention marker", () => {
  test.describe("desktop", () => {
    test.use(E2E_DESKTOP_CONTEXT);

    test("marks the conversation with @ and opens at that message", async ({ page }) => {
      await openWorkspaceWithStubs(page, {
        spaces: [E2E_SPACE],
        channels: [mentionedChannel, replyOnlyChannel],
      });

      await expect(page.getByRole("region", { name: "Mentions" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Mark all mentions as read" })).toHaveCount(0);

      const mentioned = page.locator(`[data-channel-row-id="${mentionedChannel.id}"]`);
      await expectMentionMarks(mentioned, page.locator(`[data-channel-row-id="${replyOnlyChannel.id}"]`));

      await mentioned.click();
      await expect(page).toHaveURL(/#message:channel-design-mention/);
    });
  });

  test.describe("mobile", () => {
    test.use(E2E_MOBILE_CONTEXT);

    test("marks the conversation with the desktop's @", async ({ page }) => {
      await openWorkspaceWithStubs(page, {
        spaces: [E2E_SPACE],
        channels: [mentionedChannel, replyOnlyChannel],
      });

      const list = page.locator(".app-mobile-channel-list-pane");
      await expect(list).toBeVisible();
      await expect(list.getByRole("region", { name: "Mentions" })).toHaveCount(0);

      await expectMentionMarks(list.locator(`[data-mobile-channel-row-id="${mentionedChannel.id}"]`),
        list.locator(`[data-mobile-channel-row-id="${replyOnlyChannel.id}"]`));
    });
  });
});
