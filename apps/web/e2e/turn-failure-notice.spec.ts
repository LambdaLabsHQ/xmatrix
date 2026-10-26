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

const USAGE_LIMIT = {
  ...FAILURE,
  body: "xMatrix could not complete this claude turn: You've hit your session limit · resets 2:50am (UTC)\n" +
    "Failure category: provider. HTTP status: not reported by the harness.\nFailure reference: claude-limit",
  from: { ...FAILURE.from, label: "claude", agentName: "claude", instanceLabel: "claude" },
  metadata: { ...FAILURE.metadata, xmatrixFailureEvidence: { ...evidence, category: "provider", httpStatuses: [], codes: [], usageLimit: {} } },
};

async function openFailedTurn(page: Parameters<typeof openWorkspaceWithStubs>[0], failure: typeof FAILURE | typeof USAGE_LIMIT = FAILURE) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [CHANNEL] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, { messages: [ASK, failure], hasMore: false });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
}

const NO_STATUS = "xMatrix could not complete this claude turn: error_during_execution: [ede_diagnostic] " +
  "result_type=user last_content_type=n/a stop_reason=tool_use\nFailure category: provider. HTTP status: not reported by the harness.\n" +
  "Failure reference: 3caa938aaca895a7fa3a91aeb98eb13fa3ab2db9bd868337dd7186877a52444c";
const noStatusEvidence = { version: 1, category: "provider", httpStatuses: [], codes: [], requestIds: [],
  websocketCloseCodes: [], exitCodes: [] };
const AGENT = { kind: "agent" as const, identityId: "agent:channel-general:1", agentId: "channel-general:1", userId: "e2e-user", email: "",
  label: "codex", agentName: "codex", instanceId: "channel-general:1", channelInstanceId: "1", instanceLabel: "codex" };

test("a turn with no provider status says it stopped and how to continue", async ({ page }) => {
  const channel = { ...CHANNEL, messageCount: 2, lastMessageSequence: 2 };
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, {
    messages: [ASK, { ...FAILURE, body: NO_STATUS, from: { ...AGENT, label: "claude", agentName: "claude", instanceLabel: "claude:1" },
      metadata: { ...FAILURE.metadata, xmatrixFailureEvidence: noStatusEvidence } }],
    hasMore: false,
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  const card = page.getByRole("group", { name: "claude:1 couldn't finish this turn" });
  await expect(card).toContainText("without an HTTP status or an error code", { timeout: 20_000 });
  await expect(card.getByText("To continue", { exact: true })).toBeVisible();
  await expect(card.getByText("Reply to it to continue.", { exact: true })).toBeVisible();
  await expect(card.getByText("Original error:", { exact: false })).toContainText("ede_diagnostic");
  await expect(card.getByText("Failure reference:", { exact: false })).toBeHidden();
});

test("a later message from the same agent settles the turn-failure card", async ({ page }) => {
  const channel = { ...CHANNEL, messageCount: 3, lastMessageSequence: 3 };
  const followed = { messageId: "followed", channelId: CHANNEL.id, sequence: 3, sentAt: "2026-07-01T00:01:00.000Z",
    body: "Picked the dry run up again.", from: AGENT };
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, {
    messages: [ASK, FAILURE, followed], hasMore: false,
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  const card = page.getByRole("group", { name: "codex was rate limited by its provider" });
  await expect(card.getByRole("status")).toHaveText("codex continued afterward", { timeout: 20_000 });
  await expect(card.getByText("To fix it", { exact: true })).toBeHidden();
  await expect(card.getByText("Wait a few minutes", { exact: false })).toBeHidden();
});

test("a rate-limited turn says so and what to do, with the diagnostics folded away", async ({ page }) => {
  await openFailedTurn(page);
  const card = page.getByRole("group", { name: "codex was rate limited by its provider" });
  await expect(card).toContainText("Wait a few minutes, then reply to it to continue.", { timeout: 20_000 });
  await expect(card.getByText("Original error:", { exact: false })).toContainText("429 Too Many Requests");
  await expect(card.getByText("Failure reference: turn-7f3a", { exact: false })).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("turn-failure-after.png") });
  await card.getByText("Details", { exact: true }).click();
  await expect(card.getByText("Failure reference: turn-7f3a", { exact: false })).toBeVisible();
});

test("a used-up Claude quota shows the original reset hint with no immediate-retry advice", async ({ page }) => {
  await openFailedTurn(page, USAGE_LIMIT);
  const card = page.getByRole("group", { name: "claude's provider quota is used up" });
  await expect(card).toContainText("Wait for the provider quota to reset");
  await expect(card.getByText("Original error:", { exact: false })).toContainText("You've hit your session limit · resets 2:50am (UTC)");
  await expect(card).not.toContainText("Reply to it to try again.");
  await expect(card.getByText("Failure reference: claude-limit", { exact: false })).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("claude-usage-limit-en.png") });
});

test("an unclassified older notice still exposes its actual cause before opening Details", async ({ page }) => {
  const failure = { ...FAILURE, body: "xMatrix could not complete this claude turn: error_during_execution: upstream ended the response\n" +
    "Failure category: provider. HTTP status: not reported by the harness.\nFailure reference: unknown-error",
    metadata: { ...FAILURE.metadata, xmatrixFailureEvidence: { ...evidence, category: "provider", httpStatuses: [], codes: ["upstream_failure"] } } };
  await openFailedTurn(page, failure);
  const card = page.getByRole("group", { name: "codex couldn't finish this turn" });
  await expect(card.getByText("Original error:", { exact: false })).toContainText("error_during_execution: upstream ended the response");
  await expect(card.getByText("Failure reference: unknown-error", { exact: false })).toBeHidden();
});

test.describe("for a Chinese reader", () => {
  test.use({ locale: "zh-CN" });
  test("a rate-limited turn is explained in Chinese", async ({ page }) => {
    await openFailedTurn(page);
    await expect(page.getByRole("group", { name: "codex 被服务商限流了" })).toContainText("等几分钟", { timeout: 20_000 });
    await page.screenshot({ path: test.info().outputPath("turn-failure-after-zh.png") });
  });
  test("a used-up quota and a structured UTC reset are explained in Chinese", async ({ page }) => {
    await openFailedTurn(page, { ...USAGE_LIMIT, metadata: { ...USAGE_LIMIT.metadata,
      xmatrixFailureEvidence: { ...USAGE_LIMIT.metadata.xmatrixFailureEvidence, usageLimit: { resetsAt: "2026-10-27T02:50:00Z" } } } });
    const card = page.getByRole("group", { name: "claude 的服务商额度已用尽" });
    await expect(card).toContainText("等服务商额度重置后");
    await expect(card.getByText("原始错误：", { exact: false })).toContainText("resets 2:50am (UTC)");
    await expect(card.getByText("额度重置时间：", { exact: false })).toContainText("02:50 UTC");
    await page.screenshot({ path: test.info().outputPath("claude-usage-limit-zh.png") });
  });

  test("a turn with no provider status is explained in Chinese, and settles after the agent continues", async ({ page }) => {
    const channel = { ...CHANNEL, messageCount: 3, lastMessageSequence: 3 };
    const agent = { ...AGENT, label: "claude", agentName: "claude", instanceLabel: "claude:1" };
    await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
    await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, {
      messages: [ASK, { ...FAILURE, body: NO_STATUS, from: agent,
        metadata: { ...FAILURE.metadata, xmatrixFailureEvidence: noStatusEvidence } },
      { messageId: "followed", channelId: CHANNEL.id, sequence: 3, sentAt: "2026-07-01T00:01:00.000Z",
        body: "预检已经接上了。", from: agent }],
      hasMore: false,
    });
    await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
    const card = page.getByRole("group", { name: "claude:1 这一轮没有做完" });
    await expect(card.getByRole("status")).toHaveText("claude:1 后来继续了", { timeout: 20_000 });
    await expect(card.getByText("怎么修复", { exact: true })).toBeHidden();
    await expect(card.getByText("接着做", { exact: true })).toBeHidden();
  });
});
