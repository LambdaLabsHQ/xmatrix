import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, E2E_USER_SENDER,
  fixtureJson, fixtureRequestBodies, fixtureRule, installWorkspaceStubs } from "./workspace-fixtures";

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
      message: "xMatrix read this as an explanation or report, not asking an Agent to start; write launch:force after the mention to start one anyway. No launch was allocated.",
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

test("a just-sent summon shows Jev reading it, and the shimmer ends on its own", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 2_000) });
  await install(page, "@claude fix the flaky registration test", {});
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const pending = page.locator(".app-mention-summon-written");
  await expect(pending).toHaveAttribute("data-reading", "true");
  await expect(pending).toContainText("xMatrix is reading");
  await page.screenshot({ path: "test-results/summon-intent-reading.png", clip: { x: 0, y: 0, width: 1280, height: 900 } });
  await page.clock.runFor(31_000);
  await expect(pending).not.toHaveAttribute("data-reading", "true");
  await expect(pending).not.toContainText("xMatrix is reading");
});

test("the composer previews summon intent on its address without a caption and sends the exact reading", async ({ page }) => {
  await install(page, "hello", {});
  const mention = "@claude repo:owner/xmatrix";
  const reading = { start: 0, end: mention.length, mention, choice: "summon" };
  await fixtureJson(page, "draft-intent", "**/api/xmatrix/channels/channel-general/summon-intent", { readings: [reading] });
  await fixtureJson(page, "preview-send", "**/api/xmatrix/channels/channel-general/messages", {});
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const input = page.locator("textarea.composer-textarea").first();
  const draft = `${mention} fix the flaky test`;
  await input.fill(draft);
  await expect(page.locator(".app-composer-summon-pill")).toHaveCount(0);
  await expect(page.getByTestId("composer-summon-hint")).toHaveCount(0);
  await expect(page.getByTestId("composer-summon-declined")).toHaveCount(0);
  await expect(page.locator('.app-composer-mention-band[data-intent="summon"]').first()).toBeVisible();
  await page.screenshot({ path: "test-results/summon-intent-composer.png", clip: { x: 0, y: 500, width: 1280, height: 400 } });
  await input.press("Enter");
  await expect.poll(async () => (await fixtureRequestBodies(page, "preview-send")).length).toBe(1);
  const [sent] = await fixtureRequestBodies(page, "preview-send") as Array<{ body: string; summonIntents: unknown[] }>;
  expect(sent.body).toBe(draft);
  expect(sent.summonIntents).toEqual([reading]);
  expect((await fixtureRequestBodies(page, "draft-intent")).length).toBe(1);
});

test("changed drafts discard the old reading and forced summons skip preview", async ({ page }) => {
  await install(page, "hello", {});
  await fixtureJson(page, "draft-start", "**/api/xmatrix/channels/channel-general/summon-intent", {
    readings: [{ start: 0, end: 7, mention: "@claude", choice: "summon" }],
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const input = page.locator("textarea.composer-textarea").first();
  await input.fill("@claude fix it");
  await expect(page.locator('.app-composer-mention-band[data-intent="summon"]').first()).toBeVisible();
  await fixtureRule(page, { id: "draft-decline", pattern: "**/api/xmatrix/channels/channel-general/summon-intent",
    responder: { kind: "static", delayMs: 500, json: {
      readings: [{ start: 0, end: 7, mention: "@claude", choice: "explanation" }],
    } } });
  await input.fill("@claude was the heading");
  await expect(page.locator('.app-composer-mention-band[data-intent="summon"]')).toHaveCount(0);
  await expect(page.getByTestId("composer-summon-declined")).toBeVisible();
  await expect(page.locator('.app-composer-mention-band[data-intent="declined"]').first()).toBeVisible();
  await page.screenshot({ path: "test-results/summon-intent-composer-declined.png", clip: { x: 0, y: 500, width: 1280, height: 400 } });
  await page.getByTestId("composer-summon-declined").click();
  const options = page.getByRole("dialog");
  await expect(options).toContainText("xMatrix thinks this sentence is not asking to start an Agent.");
  await expect(page.getByTestId("composer-summon-hint")).toHaveCount(0);
  await page.screenshot({ path: "test-results/summon-intent-composer-options.png", clip: { x: 0, y: 500, width: 1280, height: 400 } });
  await options.getByRole("button", { name: "Start anyway" }).click();
  await expect(input).toHaveValue("@claude launch:force was the heading");
  await expect(page.getByTestId("composer-summon-declined")).toHaveCount(0);
  await expect(page.locator('.app-composer-mention-band[data-forced="true"]').first()).toBeVisible();
  expect((await fixtureRequestBodies(page, "draft-decline")).length).toBe(1);
});

test("Enter finishes the draft preview before publishing and reuses an in-flight request", async ({ page }) => {
  await install(page, "hello", {});
  const reading = { start: 0, end: 7, mention: "@claude", choice: "reference" };
  await fixtureRule(page, { id: "slow-preview", pattern: "**/api/xmatrix/channels/channel-general/summon-intent",
    responder: { kind: "static", delayMs: 500, json: { readings: [reading] } } });
  await fixtureJson(page, "quick-send", "**/api/xmatrix/channels/channel-general/messages", {});
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const input = page.locator("textarea.composer-textarea").first();
  await input.fill("@claude is the Agent name");
  await input.press("Enter");
  await expect.poll(async () => (await fixtureRequestBodies(page, "quick-send")).length).toBe(1);
  const [sent] = await fixtureRequestBodies(page, "quick-send") as Array<{ summonIntents: unknown[] }>;
  expect(sent.summonIntents).toEqual([reading]);
  expect((await fixtureRequestBodies(page, "slow-preview")).length).toBe(1);
});

test("an unavailable preview leaves sending usable with the ordinary intent check", async ({ page }) => {
  await install(page, "hello", {});
  await fixtureRule(page, { id: "failed-preview", pattern: "**/api/xmatrix/channels/channel-general/summon-intent",
    responder: { kind: "static", status: 503, json: { error: "unavailable" } } });
  await fixtureJson(page, "fallback-send", "**/api/xmatrix/channels/channel-general/messages", {});
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const input = page.locator("textarea.composer-textarea").first();
  await input.fill("@claude fix it");
  await expect.poll(async () => (await fixtureRequestBodies(page, "failed-preview")).length).toBe(1);
  await expect(page.getByTestId("composer-summon-hint")).toHaveCount(0);
  await input.press("Enter");
  await expect.poll(async () => (await fixtureRequestBodies(page, "fallback-send")).length).toBe(1);
  const [sent] = await fixtureRequestBodies(page, "fallback-send") as Array<{ summonIntents?: unknown[] }>;
  expect(sent.summonIntents).toBeUndefined();
});


test("declined options anchor to the exact mobile mention and Start anyway changes only that occurrence", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await install(page, "hello", {});
  const body = "@claude fix it; @claude was the heading";
  const start = body.lastIndexOf("@claude");
  await fixtureJson(page, "mobile-draft", "**/api/xmatrix/channels/channel-general/summon-intent", {
    readings: [{ start: 0, end: 7, mention: "@claude", choice: "summon" },
      { start, end: start + 7, mention: "@claude", choice: "explanation" }],
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const input = page.locator("textarea.composer-textarea").first();
  await input.fill(body);
  const trigger = page.getByTestId("composer-summon-declined");
  await expect(trigger).toHaveCount(1);
  await expect(trigger).toHaveAttribute("data-start", String(start));
  const triggerBox = await trigger.boundingBox();
  const mentionBox = await page.locator(`[data-mention][data-start="${start}"]`).boundingBox();
  expect(Math.abs(triggerBox!.x - mentionBox!.x)).toBeLessThan(1);
  expect(Math.abs(triggerBox!.y - mentionBox!.y)).toBeLessThan(1);
  await trigger.click();
  const options = page.getByRole("dialog");
  await expect(options).toBeVisible();
  const popupBox = await options.boundingBox();
  expect(popupBox!.x).toBeGreaterThanOrEqual(0);
  expect(popupBox!.x + popupBox!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/summon-intent-composer-options-mobile.png" });
  await options.getByRole("button", { name: "Start anyway" }).click();
  await expect(input).toHaveValue("@claude fix it; @claude launch:force was the heading");
});
