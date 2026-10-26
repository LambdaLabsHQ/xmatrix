import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, E2E_USER_SENDER, fixtureJson, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const CHANNEL = { ...E2E_CHANNEL, messageCount: 2, lastMessageSequence: 2, updatedAt: E2E_NOW };
const ASK = { messageId: "ask", channelId: CHANNEL.id, sequence: 1, body: "@codex refactor the billing page", sentAt: E2E_NOW,
  from: { ...E2E_USER_SENDER, identityId: "user:e2e-user" } };
/* A Codex turn the provider rate limited, as the Hub wrote it in the last two weeks. */
const RATE_LIMITED = "xMatrix could not complete this codex turn: exceeded retry limit, last status: 429 Too Many Requests | " +
  "codexErrorInfo=responseTooManyFailedAttempts | httpStatusCode=429\nFailure category: http. HTTP status: 429.\n" +
  "Upstream code: responseTooManyFailedAttempts.\nFailure reference: turn-7f3a";
const evidence = { version: 1, category: "http", httpStatuses: [429], codes: ["responseTooManyFailedAttempts"], requestIds: [],
  websocketCloseCodes: [], exitCodes: [] };
const FAILURE = { messageId: "failure", channelId: CHANNEL.id, sequence: 2, sentAt: E2E_NOW, body: RATE_LIMITED,
  from: { kind: "agent", identityId: "agent:channel-general:1", agentId: "channel-general:1", userId: "e2e-user", email: "",
    label: "codex", agentName: "codex", instanceId: "channel-general:1", channelInstanceId: "1", instanceLabel: "codex" },
  metadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true, xmatrixTurnFailure: true, xmatrixFailureEvidence: evidence } };

async function openFailedTurn(page: Parameters<typeof openWorkspaceWithStubs>[0]) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [CHANNEL] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, { messages: [ASK, FAILURE], hasMore: false });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
}

test("a rate-limited turn says so and what to do, with the diagnostics folded away", async ({ page }) => {
  await openFailedTurn(page);
  const card = page.getByRole("group", { name: "codex was rate limited by its provider" });
  await expect(card).toContainText("Wait a few minutes, then reply to it to continue.", { timeout: 20_000 });
  await expect(card.getByText("responseTooManyFailedAttempts", { exact: false })).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("turn-failure-after.png") });
  await card.getByText("Details", { exact: true }).click();
  await expect(card.getByText("Failure reference: turn-7f3a", { exact: false })).toBeVisible();
});

test.describe("for a Chinese reader", () => {
  test.use({ locale: "zh-CN" });
  test("a rate-limited turn is explained in Chinese", async ({ page }) => {
    await openFailedTurn(page);
    await expect(page.getByRole("group", { name: "codex 被服务商限流了" })).toContainText("等几分钟", { timeout: 20_000 });
    await page.screenshot({ path: test.info().outputPath("turn-failure-after-zh.png") });
  });
});
