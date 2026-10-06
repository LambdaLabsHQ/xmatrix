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

test("a mention Jev read as an explanation settles into prose and the author can launch it anyway", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 120_000) });
  await install(page, "Correction: the summon came from my own heading, which named @claude in bold.", {
    rejections: [{ invocationId: "registration-launch:message-intent:0", channelId: E2E_CHANNEL.id, sourceMessageId: messageId,
      sourceMention: "@claude", targetRef: "claude", code: "summon_intent_explanation",
      message: "Jev read this as an explanation or report, not asking an Agent to start; write launch:force after the mention to start one anyway. No launch was allocated.",
      rejectedAt: E2E_NOW, evidenceExpiresAt: "2099-01-01T00:00:00Z" }],
  });
  await fixtureJson(page, "intent-launch-anyway", `**/api/xmatrix/channels/channel-general/messages/${messageId}/launch-anyway`,
    { launchIds: ["launch:forced"] });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const declined = page.locator(".app-mention-intent-declined");
  await expect(declined).toHaveText("@claude");
  // It reads as prose: no avatar and no status pill.
  await expect(page.locator(".app-mention-invocation")).toHaveCount(0);
  await declined.click();
  const card = page.getByRole("dialog");
  await expect(card).toContainText("Not a summon");
  await expect(card).toContainText("an explanation or report");
  await expect(card).toContainText("launch:force");
  await page.screenshot({ path: "test-results/summon-intent-declined.png", clip: { x: 0, y: 0, width: 1280, height: 900 } });
  await card.getByRole("button", { name: "Launch anyway" }).click();
  await expect(card.getByRole("button", { name: "Launch requested" })).toBeDisabled();
  await expect.poll(async () => (await fixtureRequestBodies(page, "intent-launch-anyway")).length).toBe(1);
  const [request] = await fixtureRequestBodies(page, "intent-launch-anyway") as Array<{ body: string; sourceMention: string }>;
  expect(request.sourceMention).toBe("@claude");
  expect(request.body).toContain("named @claude in bold");
});

test("a just-sent summon shows Jev reading it, and the shimmer ends on its own", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 2_000) });
  await install(page, "@claude fix the flaky registration test", {});
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const pending = page.locator(".app-mention-summon-written");
  await expect(pending).toHaveAttribute("data-reading", "true");
  await expect(pending).toContainText("Jev is reading");
  await page.screenshot({ path: "test-results/summon-intent-reading.png", clip: { x: 0, y: 0, width: 1280, height: 900 } });
  await page.clock.runFor(31_000);
  await expect(pending).not.toHaveAttribute("data-reading", "true");
  await expect(pending).not.toContainText("Jev is reading");
});

test("the composer says who decides and Force writes launch:force into the draft", async ({ page }) => {
  await install(page, "hello", {});
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const input = page.locator("textarea.composer-textarea").first();
  await input.fill("@claude repo:owner/xmatrix fix the flaky test");
  const pill = page.locator(".app-composer-summon-pill");
  await expect(pill).toContainText("Jev decides whether @claude starts");
  await page.screenshot({ path: "test-results/summon-intent-composer.png", clip: { x: 0, y: 500, width: 1280, height: 400 } });
  await pill.getByRole("button", { name: /Force/ }).click();
  await expect(input).toHaveValue("@claude repo:owner/xmatrix launch:force fix the flaky test");
  await expect(pill).toHaveAttribute("data-forced", "true");
  await expect(pill).toContainText("@claude starts directly");
  await page.screenshot({ path: "test-results/summon-intent-composer-forced.png", clip: { x: 0, y: 500, width: 1280, height: 400 } });
  await pill.getByRole("button", { name: /Forced/ }).click();
  await expect(input).toHaveValue("@claude repo:owner/xmatrix fix the flaky test");
});
