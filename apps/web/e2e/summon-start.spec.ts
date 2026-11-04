import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, E2E_USER_SENDER,
  fixtureJson, fixtureRequestBodies, installWorkspaceStubs } from "./workspace-fixtures";

const messageId = "message-intent";
test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 2 });

async function install(page: Page, body: string, result: { launches?: unknown[]; rejections?: unknown[] }) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [{ ...E2E_CHANNEL, messageCount: 1, historyHeadSequence: 1 }] });
  await fixtureJson(page, "intent-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: [{ messageId, channelId: E2E_CHANNEL.id, sequence: 1, body, sentAt: E2E_NOW, from: E2E_USER_SENDER }], hasMore: false,
  });
  await fixtureJson(page, "intent-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query",
    { launches: result.launches ?? [], rejections: result.rejections ?? [], continuations: [] });
}

test("a summon its send did not launch settles into prose and the author can start it", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 120_000) });
  await install(page, "Done: the flaky test is fixed; @claude reviewed the first draft.", {
    rejections: [{ invocationId: "registration-launch:message-intent:0", channelId: E2E_CHANNEL.id, sourceMessageId: messageId,
      sourceMention: "@claude", targetRef: "claude", code: "launch_not_requested",
      message: "This message mentions the Agent without asking one to start. An Agent starts one with xmatrix send --launch. No launch was allocated.",
      rejectedAt: E2E_NOW, evidenceExpiresAt: "2099-01-01T00:00:00Z" }],
  });
  await fixtureJson(page, "intent-launch-anyway", `**/api/xmatrix/channels/channel-general/messages/${messageId}/launch-anyway`,
    { launchIds: ["launch:forced"] });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const mentioned = page.locator(".app-mention-intent-declined");
  await expect(mentioned).toHaveText("@claude");
  // It reads as prose: no avatar and no status pill.
  await expect(page.locator(".app-mention-invocation")).toHaveCount(0);
  await mentioned.click();
  const card = page.getByRole("dialog");
  await expect(card).toContainText("Mentioned");
  await expect(card).toContainText("without asking it to start");
  await expect(card).toContainText("xmatrix send --launch");
  await page.screenshot({ path: "test-results/summon-mention-only.png", clip: { x: 0, y: 0, width: 1280, height: 900 } });
  await card.getByRole("button", { name: "Start", exact: true }).click();
  await expect(card.getByRole("button", { name: "Start requested" })).toBeDisabled();
  await expect.poll(async () => (await fixtureRequestBodies(page, "intent-launch-anyway")).length).toBe(1);
  const [request] = await fixtureRequestBodies(page, "intent-launch-anyway") as Array<{ body: string; sourceMention: string }>;
  expect(request.sourceMention).toBe("@claude");
  expect(request.body).toContain("@claude reviewed the first draft");
});

test("a machine the author must name is a card, not a failed launch", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 120_000) });
  await install(page, "@auto check the deploy", {
    rejections: [{ invocationId: "registration-launch:message-intent:0", channelId: E2E_CHANNEL.id, sourceMessageId: messageId,
      sourceMention: "@auto", targetRef: "auto", code: "registration_machine_not_auto_assigned",
      message: "Only machines their owners keep out of automatic assignment can run this; name one with machine:<name> to use it. No launch was allocated.",
      rejectedAt: E2E_NOW, evidenceExpiresAt: "2099-01-01T00:00:00Z" }],
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const hint = page.locator(".app-mention-launch-hint");
  await expect(hint).toHaveText("@auto");
  await expect(page.locator(".app-mention-invocation")).toHaveCount(0);
  await hint.click();
  const card = page.getByRole("dialog");
  await expect(card).toContainText("Name a machine");
  await expect(card).toContainText("machine:<name>");
  await expect(card).not.toContainText("Failed");
});

test("a just-sent summon shows it starting, and the shimmer ends on its own", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 2_000) });
  await install(page, "@claude fix the flaky registration test", {});
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const pending = page.locator(".app-mention-summon-written");
  await expect(pending).toHaveAttribute("data-reading", "true");
  await expect(pending).toContainText("Starting");
  await page.screenshot({ path: "test-results/summon-starting.png", clip: { x: 0, y: 0, width: 1280, height: 900 } });
  await page.clock.runFor(31_000);
  await expect(pending).not.toHaveAttribute("data-reading", "true");
  await expect(pending).not.toContainText("Starting");
});

test("the composer asks every send to start the Agents it summons", async ({ page }) => {
  await install(page, "hello", {});
  await fixtureJson(page, "composer-send", "**/api/xmatrix/channels/channel-general/messages", {});
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const input = page.locator(".composer-textarea").first();
  const draft = "@claude repo:owner/xmatrix fix the flaky test";
  await input.fill(draft);
  await expect(page.locator('.composer-textarea .app-mention-chip[data-intent]')).toHaveCount(0);
  await input.press("Enter");
  await expect.poll(async () => (await fixtureRequestBodies(page, "composer-send")).length).toBe(1);
  const [sent] = await fixtureRequestBodies(page, "composer-send") as Array<{ body: string; launch?: boolean; summonIntents?: unknown }>;
  expect(sent.body).toBe(draft);
  expect(sent.launch).toBe(true);
  expect(sent.summonIntents).toBeUndefined();
});
