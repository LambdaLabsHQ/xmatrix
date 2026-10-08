import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, E2E_USER_SENDER, fixtureJson, fixtureRequestBodies,
  installWorkspaceStubs } from "./workspace-fixtures";

const messageId = "message-first";
const body = "The login test flakes on CI about one run in five — find out why and fix it";
const deadlineAt = new Date(Date.parse(E2E_NOW) + 3_000).toISOString();
test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 2 });

function location(harness: string) {
  return { key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "machine", harness },
    displayName: harness, ownerName: "Owner", machineName: "Workstation", version: 1, state: "enabled", routingReady: true,
    models: [], canManageOwnerGrant: false, canConfigureSpace: false, canRemoveFromSpace: false };
}

async function install(page: Page, launchChoices: unknown[]) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE],
    channels: [{ ...E2E_CHANNEL, metadata: { autoName: true }, messageCount: 1, historyHeadSequence: 1 }] });
  await fixtureJson(page, "first-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: [{ messageId, channelId: E2E_CHANNEL.id, sequence: 1, body, sentAt: E2E_NOW, from: E2E_USER_SENDER }], hasMore: false,
  });
  const locations = ["claude", "codex", "gemini"].map(location);
  await fixtureJson(page, "first-catalog", "**/api/xmatrix/spaces/*/agent-registrations", {
    registrations: locations, capabilities: locations.map(item => ({ harness: item.key.harness, models: [], locations: [item] })),
  });
  await launches(page, launchChoices);
}

async function launches(page: Page, launchChoices: unknown[]) {
  await fixtureJson(page, "first-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query",
    { launches: [], rejections: [], continuations: [], launchChoices });
}

const openChoice = (extra: Record<string, unknown> = {}) => ({ channelId: E2E_CHANNEL.id, messageId, deadlineAt, ...extra });
const shot = async (page: Page, name: string) => {
  // Virtuoso hides rows for a moment after a resize or reload.
  await expect(page.locator(".launch-choice")).toBeVisible();
  const row = page.locator(".launch-choice").locator("xpath=ancestor::*[contains(@class,'group')][1]");
  await page.screenshot({ path: `test-results/${name}.png`, clip: (await row.boundingBox()) ?? undefined });
};

test("the author's three seconds start when Jev's reading appears, and a pick settles the card", async ({ page }) => {
  // Opening the conversation took 2.5s and Jev has not read the message yet.
  const open = (extra: Record<string, unknown> = {}) => openChoice({ open: true, ...extra });
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 2_500) });
  await install(page, [open()]);
  await fixtureJson(page, "first-choice", `**/api/xmatrix/channels/channel-general/messages/${messageId}/launch-choice`,
    { claimed: true });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const card = page.locator(".launch-choice");
  // The author may pick at once, but nothing counts down before Jev's reading.
  await expect(card.getByRole("button", { name: "Start claude" })).toBeEnabled();
  await expect(card).toContainText("xMatrix is reading");
  await expect(card.locator(".launch-choice-count")).toHaveCount(0);
  expect(await fixtureRequestBodies(page, "first-choice")).toEqual([]);
  await shot(page, "launch-choice-reading");

  // Jev's reading arrives: the author's three seconds start, and the Hub is told.
  await launches(page, [open({ recommendation: { start: true, harness: "codex" } })]);
  await page.clock.runFor(700);
  await expect(card.getByRole("button", { name: "Start codex (xMatrix's pick)" })).toHaveAttribute("data-recommended", "true");
  // Far enough ahead that a loaded runner has not already passed it.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 250));
  await expect(card.locator(".launch-choice-count")).toHaveText(/^[23]$/u);
  await expect.poll(async () => (await fixtureRequestBodies(page, "first-choice")).length).toBe(1);
  expect((await fixtureRequestBodies(page, "first-choice"))[0]).toEqual({ body, shown: true });
  await shot(page, "launch-choice-jev");

  await card.getByRole("button", { name: "Start claude" }).click();
  await expect.poll(async () => (await fixtureRequestBodies(page, "first-choice")).length).toBe(2);
  const [, request] = await fixtureRequestBodies(page, "first-choice") as Array<{ body: string; harness?: string }>;
  expect(request).toEqual({ body, harness: "claude" });

  await launches(page, [open({ open: false, recommendation: { start: true, harness: "codex" },
    choice: { start: true, harness: "claude", by: "author", at: E2E_NOW } })]);
  await page.clock.runFor(1_000);
  // The pick is summoned by xMatrix's `@claude` reply, which shows the launch itself.
  await expect(card).toHaveAttribute("data-state", "chosen");
  await expect(card).toContainText("claude");
  await expect(card).toContainText("Your pick");
  await shot(page, "launch-choice-chosen");
  await expect(card.getByRole("button")).toHaveCount(0);
});

test("unchosen, Jev's reading decides: conversation starts nothing and says so quietly", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 5_000) });
  await install(page, [openChoice({ recommendation: { start: false }, choice: { start: false, by: "jev", at: deadlineAt } })]);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const card = page.locator(".launch-choice");
  await expect(card).toHaveAttribute("data-state", "none");
  await expect(card).toContainText("No Agent started");
  await expect(card).toContainText("xMatrix read this as conversation");
  await shot(page, "launch-choice-none");

  await launches(page, [openChoice({ recommendation: { start: true, harness: "codex" },
    choice: { start: true, harness: "codex", by: "jev", at: deadlineAt } })]);
  await page.reload();
  await expect(card).toHaveAttribute("data-state", "chosen");
  await expect(card).toContainText("xMatrix's pick");
  await shot(page, "launch-choice-jev-chosen");
});

test("a picture stays with the words and the choice follows both", async ({ page }) => {
  const src = "/e2e-launch-choice.png";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.route(`**${src}`, (route) => route.fulfill({ status: 200, contentType: "image/png", body: png }));
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 5_000) });
  await install(page, [openChoice({
    recommendation: { start: true, harness: "codex" },
    choice: { start: true, harness: "codex", by: "jev", at: E2E_NOW },
  })]);
  await fixtureJson(page, "first-history-picture", "**/api/xmatrix/channels/channel-general/history**", {
    messages: [{
      messageId, channelId: E2E_CHANNEL.id, sequence: 1, body, sentAt: E2E_NOW, from: E2E_USER_SENDER,
      attachments: [{ id: "shot", kind: "image", name: "shot.png", mimeType: "image/png", size: png.length, url: src }],
    }],
    hasMore: false,
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const words = page.locator(".app-message-row .rich-message").getByText(body, { exact: true });
  const picture = page.locator(".message-image-attachment");
  const choice = page.locator(".launch-choice");
  await expect(choice).toHaveAttribute("data-state", "chosen");
  await expect(picture).toBeVisible();
  const [wordBox, pictureBox, choiceBox] = await Promise.all([
    words.boundingBox(), picture.boundingBox(), choice.boundingBox(),
  ]);
  expect(wordBox && pictureBox && choiceBox).toBeTruthy();
  // The picture follows the words directly. The choice is the line under both.
  expect(pictureBox!.y).toBeGreaterThan(wordBox!.y + wordBox!.height - 1);
  expect(pictureBox!.y - (wordBox!.y + wordBox!.height)).toBeLessThan(32);
  expect(choiceBox!.y).toBeGreaterThanOrEqual(pictureBox!.y + pictureBox!.height - 1);

  await page.setViewportSize({ width: 390, height: 844 });
  const [phoneWords, phonePicture, phoneChoice] = await Promise.all([
    words.boundingBox(), picture.boundingBox(), choice.boundingBox(),
  ]);
  expect(phoneWords && phonePicture && phoneChoice).toBeTruthy();
  expect(phonePicture!.y - (phoneWords!.y + phoneWords!.height)).toBeLessThan(32);
  expect(phoneChoice!.y).toBeGreaterThanOrEqual(phonePicture!.y + phonePicture!.height - 1);
});

test("reopened after Jev could not read it, the card says why and never counts down again", async ({ page }) => {
  // A minute after sending: Jev could not decide, nobody chose.
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 60_000) });
  await install(page, [openChoice({ failureCode: "registration_environment_selection_failed" })]);
  await fixtureJson(page, "late-shown", `**/api/xmatrix/channels/channel-general/messages/${messageId}/launch-choice`, { claimed: false });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const failed = page.locator(".launch-choice[data-state='none']");
  await expect(failed).toContainText("xMatrix could not select a registered environment.");
  await expect(failed.getByRole("button")).toHaveCount(0);
  expect(await fixtureRequestBodies(page, "late-shown")).toEqual([]);
});
