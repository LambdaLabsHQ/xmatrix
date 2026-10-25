import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, E2E_USER_SENDER, conversationOpened, installWorkspaceStubs,
} from "./workspace-fixtures";
import { fixtureJson } from "./in-page-api-fixtures";

/* A Free Space that ran out mid-task left its owner looking at Agents that had
   gone quiet: the refusal was only on a failed row of their own, and an Agent's
   refused reply leaves nothing in the timeline (user 2026-10-25). Before and
   after the limit, an ask card where Pending approvals dock now says what is
   about to stop and where to go. */

test.use(E2E_DESKTOP_CONTEXT);

const MESSAGE_COUNT = 30;

function freeBilling(remaining: number, canManage = true) {
  return { billing: {
    plan: "free", canManage, seats: { used: 1, limit: 3 },
    freeUsage: { acceptedMessages: 500 - remaining, limit: 500, remaining }, subscription: null,
  } };
}

async function openConversation(page: Parameters<typeof installWorkspaceStubs>[0], billing: unknown) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [{
    ...E2E_CHANNEL, messageCount: MESSAGE_COUNT, lastMessageSequence: MESSAGE_COUNT, updatedAt: E2E_NOW,
  }] });
  await fixtureJson(page, "channel-general-history", "**/api/xmatrix/channels/channel-general/history**", {
    hasMore: false,
    messages: Array.from({ length: MESSAGE_COUNT }, (_unused, index) => ({
      messageId: `message-${index + 1}`, channelId: E2E_CHANNEL.id, sequence: index + 1,
      body: `timeline body ${index + 1}`, sentAt: E2E_NOW,
      from: { ...E2E_USER_SENDER, identityId: "user:someone-else", userId: "someone-else" },
    })),
  });
  await fixtureJson(page, "space-billing", /\/api\/xmatrix\/spaces\/[^/]+\/billing$/u, billing);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-message-row").first()).toBeVisible();
  await conversationOpened(page);
}

test("a used-up Free Space asks above the composer, clear of the conversation, and opens Billing", async ({ page }) => {
  await openConversation(page, freeBilling(0));
  const notice = page.getByTestId("space-allowance-notice");
  await expect(notice).toHaveAttribute("data-allowance", "free-used");
  await expect(notice).toContainText("New messages and Agent replies can't be saved");
  // Docked where approvals are: in full view, not under the composer.
  await expect(notice).toBeInViewport({ ratio: 1 });
  // It sits above the composer, never under it.
  const [noticeBox, composerBox] = await Promise.all([notice.boundingBox(), page.locator(".app-composer-box").first().boundingBox()]);
  expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);
  // The conversation pads its tail for the dock, so the newest message stays readable above the card.
  await expect.poll(async () => {
    const [row, card] = await Promise.all([page.locator(".app-message-row").last().boundingBox(), notice.boundingBox()]);
    return row!.y + row!.height - card!.y;
  }).toBeLessThanOrEqual(1);
  await notice.getByRole("button", { name: "Upgrade to Pro" }).click();
  await expect(page).toHaveURL(/\/settings\?item=billing/u);
  await expect(page.getByTestId("space-billing")).toBeVisible();
});

test("the last fifth of Free is counted down; a member is sent to the owner", async ({ page }) => {
  await openConversation(page, freeBilling(42, false));
  const notice = page.getByTestId("space-allowance-notice");
  await expect(notice).toHaveAttribute("data-allowance", "free-low");
  await expect(notice).toContainText("42 of 500 free writes left");
  await expect(notice).toContainText("Ask the Space owner to upgrade.");
  await expect(notice.getByRole("button", { name: "Upgrade to Pro" })).toHaveCount(0);
});

test("a Space with room left shows nothing", async ({ page }) => {
  await openConversation(page, freeBilling(300));
  await expect(page.getByTestId("space-allowance-notice")).toHaveCount(0);
});

test("hiding folds the card to one line that stays folded for the Space until shown again", async ({ page }) => {
  await openConversation(page, freeBilling(0));
  const notice = page.getByTestId("space-allowance-notice");
  await notice.getByRole("button", { name: "Hide" }).click();
  await expect(notice.getByRole("button", { name: "Upgrade to Pro" })).toHaveCount(0);
  await expect(notice).toContainText("This Space's free allowance is used up");
  await expect(notice).toContainText("Writes stopped");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("space-allowance-notice").getByRole("button", { name: "Show" })).toBeVisible();
  await page.getByTestId("space-allowance-notice").getByRole("button", { name: "Show" }).click();
  await expect(page.getByTestId("space-allowance-notice").getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
});
