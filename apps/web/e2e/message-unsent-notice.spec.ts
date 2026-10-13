import { expect, test } from "./fixtures";
import { fixtureJson } from "./in-page-api-fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_USER_SENDER,
  channelHistoryFixture,
  conversationOpened,
  openGeneralChannelWithHistory,
} from "./workspace-fixtures";

/* A message that did not go out used to say so in one small label beside the
   time, and not at all under the sender's previous message, so it was typed
   again (user 2026-10-13: "这个很难看出来是我消息没发出去，要更显眼一点"). The row
   now carries the filled badge chat apps use, on a line under its body with
   the two things left to do. */

test.use(E2E_DESKTOP_CONTEXT);

type Page = Parameters<Parameters<typeof test>[2]>[0]["page"];

const HISTORY_LENGTH = 6;
const SEND_ROUTE = "**/api/xmatrix/channels/channel-general/messages";

async function sendRefused(page: Page, body: string) {
  await openGeneralChannelWithHistory(
    page,
    { ...E2E_CHANNEL, updatedAt: E2E_NOW, messageCount: HISTORY_LENGTH, lastMessageSequence: HISTORY_LENGTH,
      historyHeadSequence: HISTORY_LENGTH, contentAuthority: { protocolVersion: 1, contentRevision: 1 } },
    channelHistoryFixture(HISTORY_LENGTH, "unsent"),
  );
  await fixtureJson(page, "send-refused", SEND_ROUTE, { error: "Channel is read-only" }, { method: "POST", status: 403 });
  await conversationOpened(page);
  const draft = page.locator("textarea.composer-textarea").first();
  await draft.fill(body);
  await draft.press("Enter");
  const row = page.locator(".app-message-row").filter({ hasText: body });
  await expect(row.locator("[data-message-unsent='failed']")).toBeVisible();
  return row;
}

test("a message that failed to send says so under its greyed body, behind a filled badge", async ({ page }) => {
  const row = await sendRefused(page, "Did this go out?");
  const notice = row.locator("[data-message-unsent]");
  await expect(notice).toContainText("Not sent");
  await expect(notice.getByRole("button", { name: "Send again" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Delete" })).toBeVisible();

  const drawn = await row.evaluate((element) => {
    const body = element.querySelector(".app-message-unsent-body")!;
    const slip = element.querySelector("[data-message-unsent]")!;
    const badge = getComputedStyle(slip.querySelector(".app-message-unsent-badge")!);
    return {
      bodyOpacity: Number(getComputedStyle(body).opacity),
      badgeFilled: badge.backgroundColor !== "rgba(0, 0, 0, 0)" && badge.width === "18px",
      slipBelowBody: slip.getBoundingClientRect().top >= body.getBoundingClientRect().bottom,
    };
  });
  expect(drawn).toEqual({ bodyOpacity: 0.5, badgeFilled: true, slipBelowBody: true });
});

test("Send again posts the same message and the notice goes once it is written", async ({ page }) => {
  const row = await sendRefused(page, "Second try");
  await fixtureJson(page, "send-accepted", SEND_ROUTE, { message: {
    messageId: "unsent-retried", channelId: E2E_CHANNEL.id, sequence: HISTORY_LENGTH + 1, body: "Second try",
    sentAt: new Date().toISOString(), from: { ...E2E_USER_SENDER, identityId: "user:e2e-user" },
  } }, { method: "POST" });
  await row.getByRole("button", { name: "Send again" }).click();

  await expect(page.locator("[id='message:unsent-retried']")).toBeVisible();
  await expect(page.locator("[data-message-unsent]")).toHaveCount(0);
  await expect(page.locator(".app-message-row").filter({ hasText: "Second try" })).toHaveCount(1);
});

test("Delete drops a message that was never sent", async ({ page }) => {
  const row = await sendRefused(page, "Never mind");
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".app-message-row").filter({ hasText: "Never mind" })).toHaveCount(0);
});
