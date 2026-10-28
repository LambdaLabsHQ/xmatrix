import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, E2E_USER_SENDER,
  fixtureJson, fixtureRule, fixtureRequestBodies, fixtureRequests, releaseFixture, openWorkspaceWithStubs } from "./workspace-fixtures";
import type { AgentQuotaRetry } from "@xmatrix/protocol";

test.use(E2E_DESKTOP_CONTEXT);
const id = "a".repeat(64);
const channel = { ...E2E_CHANNEL, messageCount: 2, lastMessageSequence: 2, updatedAt: E2E_NOW };
const originalError = "You've hit your session limit · resets 10:20am (UTC)";

async function openOffer(page: Parameters<typeof openWorkspaceWithStubs>[0], canChoose = true, providerError = true) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${channel.id}/history**`, { messages: [
    { messageId: "ask", channelId: channel.id, sequence: 1, body: "@claude finish the task", sentAt: E2E_NOW, from: E2E_USER_SENDER },
    { messageId: "quota-offer", channelId: channel.id, sequence: 2, sentAt: E2E_NOW,
      body: (providerError ? `xMatrix could not complete this claude turn: ${originalError}\nFailure reference: quota-failure\n\n` : "") +
        "No Agent could take over this task.", from: { ...E2E_USER_SENDER, label: "xMatrix" },
      metadata: { kind: "xmatrix.quota-retry-offer", xmatrixQuotaRetryId: id, xmatrixProvenance: "system_fact", xmatrixSystemNotice: true } },
  ], hasMore: false });
  const value = (state: AgentQuotaRetry["state"]) => ({ id, state, canChoose, expiresAt: new Date(Date.now()+86_400_000).toISOString() });
  const pattern = `**/api/xmatrix/channels/${channel.id}/quota-retries/${id}`;
  await fixtureJson(page, "quota-read", pattern, value("offered"), { method: "GET" });
  await fixtureRule(page, { id: "quota-choice", pattern, method: "POST", responder: { kind: "sequence", responses: [
    { status: 202, json: value("waiting") }, { status: 202, json: value("cancelled") },
  ] } });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  return { card: page.getByRole("group", { name: providerError ? originalError : "Provider account usage limit reached" }),
    pattern, value,
    actions: () => fixtureRequestBodies(page, "quota-choice"),
    showWaitingOnReload: async () => {
      await fixtureJson(page, "quota-read", pattern, value("waiting"), { method: "GET" });
      await fixtureJson(page, "quota-choice", pattern, value("cancelled"), { method: "POST", status: 202 });
    },
  };
}

test("waiting requires an explicit choice, survives reload and can be cancelled without another send", async ({ page }) => {
  const { card, actions, showWaitingOnReload, pattern, value } = await openOffer(page);
  await expect(card.getByRole("button", { name: "Retry when quota recovers" })).toBeVisible();
  expect(await actions()).toEqual([]);
  await fixtureJson(page, "quota-read", pattern, value("waiting"), { method: "GET" });
  await card.getByRole("button", { name: "Retry when quota recovers" }).click();
  await expect(card.getByRole("status")).toHaveText("Queued, waiting for provider quota");
  expect(await actions()).toEqual([{ action: "wait" }]);
  await page.screenshot({ path: test.info().outputPath("quota-waiting.png") });
  await showWaitingOnReload();
  await page.reload();
  await expect(card.getByRole("button", { name: "Cancel waiting" })).toBeVisible();
  expect(await actions()).toEqual([{ action: "wait" }]);
  await card.getByRole("button", { name: "Cancel waiting" }).click();
  await expect(card.getByRole("status")).toHaveText("Waiting cancelled");
  expect(await actions()).toEqual([{ action: "wait" }, { action: "cancel" }]);
  await expect(card.getByRole("button", { name: "Retry when quota recovers" })).toHaveCount(0);
});

test("other readers see the offer but cannot enroll its author's work", async ({ page }) => {
  const { card, actions } = await openOffer(page, false, false);
  await expect(card.getByRole("status")).toHaveText("Retry automatically when quota recovers?");
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(await actions()).toEqual([]);
});

test("a choice restarts polling and a crossed older read cannot restore its previous state", async ({ page }) => {
  await page.clock.install();
  const { card, pattern, value } = await openOffer(page);
  await expect(card.getByRole("button", { name: "Retry when quota recovers" })).toBeVisible();
  await fixtureRule(page, { id: "quota-choice", pattern, method: "POST",
    responder: { kind: "deferred", status: 202, json: value("waiting") } });
  await fixtureRule(page, { id: "quota-stale-read", pattern, method: "GET",
    responder: { kind: "deferred", json: value("offered") } });
  await card.getByRole("button", { name: "Retry when quota recovers" }).click();
  await page.clock.fastForward(30_001);
  await expect.poll(() => fixtureRequests(page, "quota-stale-read")).toHaveLength(1);
  await fixtureJson(page, "quota-current-read", pattern, value("dispatched"), { method: "GET" });
  await releaseFixture(page, "quota-choice");
  await expect(card.getByRole("status")).toHaveText("Retry submitted");
  await releaseFixture(page, "quota-stale-read");
  await page.clock.runFor(100);
  await expect(card.getByRole("status")).toHaveText("Retry submitted");
  expect(await fixtureRequestBodies(page, "quota-choice")).toEqual([{ action: "wait" }]);
});
