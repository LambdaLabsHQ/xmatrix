import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_MOBILE_CONTEXT,
  E2E_NOW,
  E2E_USER_SENDER,
  fixtureJson,
  fixtureRequestBodies,
  openGeneralChannelWithHistory,
} from "./workspace-fixtures";

const MESSAGE_BODY = "Who reacted to this message is visible";
const REACTION_TOGGLE_RULE = "message-reaction-toggle";
const REACTED_MESSAGE = {
  messageId: "message-reacted",
  channelId: E2E_CHANNEL.id,
  sequence: 1,
  body: MESSAGE_BODY,
  sentAt: E2E_NOW,
  from: E2E_USER_SENDER,
  reactions: [{
    emoji: "👍",
    reactors: [
      { identityId: "user:e2e-user", label: "E2E Tester" },
      { identityId: "agent:claude", label: "claude" },
    ],
  }],
};

async function openReactedMessage(page: Page) {
  await openGeneralChannelWithHistory(
    page,
    { ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1, updatedAt: E2E_NOW },
    [REACTED_MESSAGE],
  );
  await fixtureJson(
    page,
    REACTION_TOGGLE_RULE,
    "**/api/xmatrix/channels/*/messages/*/reactions",
    { message: REACTED_MESSAGE },
    { method: "POST" },
  );
  const reactionToggles = () => fixtureRequestBodies(page, REACTION_TOGGLE_RULE);
  const chip = page.getByRole("button", { name: "You and claude reacted with 👍" });
  await expect(chip).toBeVisible();
  const card = page.getByRole("tooltip").filter({ hasText: "You and claude" });
  return { chip, card, reactionToggles };
}

test.describe("desktop", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("hovering a reaction shows who reacted without toggling it", async ({ page }) => {
    const { chip, card, reactionToggles } = await openReactedMessage(page);
    await expect(card).toBeHidden();
    await chip.hover();
    await expect(card).toBeVisible();
    await expect(card).toHaveText("👍 You and claude reacted");
    await page.mouse.move(0, 0);
    await expect(card).toBeHidden();
    expect(await reactionToggles()).toEqual([]);
  });
});

test.describe("mobile", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("long-pressing a reaction shows who reacted and does not toggle it", async ({ page }) => {
    const { chip, card, reactionToggles } = await openReactedMessage(page);
    const box = await chip.boundingBox();
    if (!box) throw new Error("reaction chip has no box");
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await expect(card).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(card).toBeVisible();
    expect(await reactionToggles()).toEqual([]);

    await page.locator(".app-message-timeline").getByText(MESSAGE_BODY).tap();
    await expect(card).toBeHidden();

    // A later ordinary tap still toggles the reaction.
    await chip.tap();
    await expect.poll(reactionToggles).toEqual([{ emoji: "👍" }]);
    await expect(card).toBeHidden();
  });
});
