import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, E2E_USER_SENDER, fixtureJson, fixtureRequestBodies,
  installWorkspaceStubs, routeInvocationPush } from "./workspace-fixtures";

const messageId = "message-first";
const body = "The login test flakes on CI about one run in five — find out why and fix it";
const deadlineAt = new Date(Date.parse(E2E_NOW) + 3_000).toISOString();
test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 2 });

function location(harness: string) {
  return { key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "machine", harness },
    displayName: harness, ownerName: "Owner", machineName: "Workstation", version: 1, state: "enabled", routingReady: true,
    models: [], canManageOwnerGrant: false, canConfigureSpace: false, canRemoveFromSpace: false };
}

async function install(page: Page, launchChoices: unknown[], settings: { metadata?: Record<string, unknown>; asks?: unknown[] } = {}) {
  const push = await routeInvocationPush(page);
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE],
    channels: [{ ...E2E_CHANNEL, metadata: settings.metadata ?? { autoName: true }, messageCount: 1, historyHeadSequence: 1 }] });
  await fixtureJson(page, "first-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: [{ messageId, channelId: E2E_CHANNEL.id, sequence: 1, body, sentAt: E2E_NOW, from: E2E_USER_SENDER }], hasMore: false,
  });
  const locations = ["claude", "codex", "gemini"].map(location);
  await fixtureJson(page, "first-catalog", "**/api/xmatrix/spaces/*/agent-registrations", {
    registrations: locations, capabilities: locations.map(item => ({ harness: item.key.harness, models: [], locations: [item] })),
  });
  await launches(page, launchChoices, settings.asks);
  return push;
}

async function launches(page: Page, launchChoices: unknown[], asks: unknown[] = []) {
  await fixtureJson(page, "first-launches", "**/api/xmatrix/channels/channel-general/agent-launches/query",
    { launches: [], rejections: [], continuations: [], launchChoices, asks });
}

const openChoice = (extra: Record<string, unknown> = {}) => ({ channelId: E2E_CHANNEL.id, messageId, deadlineAt, ...extra });
const choiceUrl = `**/api/xmatrix/channels/channel-general/messages/${messageId}/launch-choice`;
const sendUrl = /\/api\/xmatrix\/channels\/channel-general\/messages$/u;
const shot = async (page: Page, name: string) => {
  // Virtuoso hides rows for a moment after a resize or reload.
  await expect(page.locator(".launch-line")).toBeVisible();
  const row = page.locator(".launch-line").locator("xpath=ancestor::*[contains(@class,'group')][1]");
  const box = (await row.boundingBox())!;
  // Room under the row for the menu, when it is open.
  await page.screenshot({ path: `test-results/${name}.png`,
    clip: { ...box, height: box.height + (await page.getByRole("menu").count() ? 200 : 8) } });
};
const open = (extra: Record<string, unknown> = {}) => openChoice({ open: true, ...extra });

/** The author's fresh first message, Jev's reading of it still to come. */
async function openFresh(page: Page) {
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 2_500) });
  const push = await install(page, [open()]);
  await fixtureJson(page, "first-choice", choiceUrl, { claimed: true });
  await fixtureJson(page, "first-send", sendUrl, { message: { messageId: "m-summon" } }, { method: "POST" });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  return push;
}

/** Jev picked codex, the author's window is running, and the author presses Change. */
async function changeFromJevsPick(page: Page) {
  const push = await openFresh(page);
  const line = page.locator(".launch-line");
  await launches(page, [open({ recommendation: { start: true, harness: "codex" } })]);
  await push();
  await page.clock.runFor(700);
  await expect(line.getByRole("button", { name: "Change" })).toBeEnabled();
  await expect.poll(async () => (await fixtureRequestBodies(page, "first-choice")).length).toBe(1);
  // Opening the menu records "start nothing": choosing is not a race against the window.
  await launches(page, [open({ open: false, recommendation: { start: true, harness: "codex" },
    choice: { start: false, by: "author", at: E2E_NOW } })]);
  await line.getByRole("button", { name: "Change" }).click();
  await expect.poll(async () => fixtureRequestBodies(page, "first-choice")).toEqual([{ body, shown: true }, { body }]);
  return line;
}

test("the line is one sentence: reading, then Jev's pick counting down, then the pick starting", async ({ page }) => {
  // Opening the conversation took 2.5s and Jev has not read the message yet.
  const push = await openFresh(page);
  const line = page.locator(".launch-line");
  // The author may act at once, but nothing counts down before Jev's reading.
  await expect(line).toContainText("Choosing an Agent…");
  await expect(line.getByRole("button", { name: "Pick one" })).toBeEnabled();
  await expect(line.getByRole("button", { name: "Don't start" })).toBeEnabled();
  await expect(line.locator(".launch-line-count")).toHaveCount(0);
  // A sentence on the paper: no card, and no Agent listed until the author asks.
  expect(await line.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.borderTopWidth, style.backgroundColor, style.boxShadow];
  })).toEqual(["0px", "rgba(0, 0, 0, 0)", "none"]);
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await fixtureRequestBodies(page, "first-choice")).toEqual([]);
  await shot(page, "launch-line-reading");

  // Jev's reading arrives: the author's three seconds start, and the Hub is told.
  await launches(page, [open({ recommendation: { start: true, harness: "codex" } })]);
  await push();
  await page.clock.runFor(700);
  await expect(line).toContainText("codex starts in");
  // Far enough ahead that a loaded runner has not already passed it.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 250));
  await expect(line.locator(".launch-line-count")).toHaveText(/^[23]s$/u);
  await expect(line.getByRole("button", { name: "Change" })).toBeEnabled();
  await expect.poll(async () => (await fixtureRequestBodies(page, "first-choice")).length).toBe(1);
  expect((await fixtureRequestBodies(page, "first-choice"))[0]).toEqual({ body, shown: true });
  await shot(page, "launch-line-jev");

  // Unchosen, the window closes and Jev's pick starts: xMatrix's `@codex` reply shows the launch.
  await launches(page, [open({ open: false, recommendation: { start: true, harness: "codex" },
    choice: { start: true, harness: "codex", by: "jev", at: E2E_NOW } })]);
  await push();
  await page.clock.runFor(1_000);
  await expect(line).toHaveAttribute("data-state", "chosen");
  await expect(line).toContainText("codex is starting");
  await expect(line.getByRole("button")).toHaveCount(0);
  await shot(page, "launch-line-chosen");
  expect(await fixtureRequestBodies(page, "first-send")).toEqual([]);
});

test("Change takes the decision first, then the Agent picked is the author's own summon", async ({ page }) => {
  const line = await changeFromJevsPick(page);
  const menu = page.getByRole("menu", { name: "Choose the Agent that starts" });
  await expect(menu.getByRole("menuitem")).toHaveText([/^claude$/u, /^codex\s*xMatrix's pick$/u, /^gemini$/u, "Model, effort, machine…"]);
  await expect(line).toContainText("Choose who starts");
  await shot(page, "launch-line-menu");
  expect(await fixtureRequestBodies(page, "first-send")).toEqual([]);

  await menu.getByRole("menuitem", { name: "claude" }).click();
  await expect.poll(async () => (await fixtureRequestBodies(page, "first-send")).map(sent => (sent as { body: string }).body))
    .toEqual(["@claude"]);
  // The summon says the rest.
  await expect(menu).toHaveCount(0);
  await expect(line).toHaveCount(0);
});

test("the menu's last row hands the summon to the composer for its other parameters", async ({ page }) => {
  const line = await changeFromJevsPick(page);
  await page.getByRole("menuitem", { name: "Model, effort, machine…" }).click();
  await expect(page.getByRole("menu", { name: "Choose the Agent that starts" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message composer" })).toContainText("@codex");
  expect(await fixtureRequestBodies(page, "first-send")).toEqual([]);
  // Nothing was sent, so the author can still ask from the line.
  await expect(line.getByRole("button", { name: "Ask an Agent" })).toBeEnabled();
});

test("Don't start is one press and leaves a way back", async ({ page }) => {
  const push = await openFresh(page);
  const line = page.locator(".launch-line");
  await line.getByRole("button", { name: "Don't start" }).click();
  await expect.poll(async () => fixtureRequestBodies(page, "first-choice")).toEqual([{ body }]);
  await launches(page, [open({ open: false, choice: { start: false, by: "author", at: E2E_NOW } })]);
  await push();
  await expect(line).toHaveAttribute("data-state", "none");
  await expect(line).toContainText("No Agent started");
  await expect(line.getByRole("button", { name: "Ask an Agent" })).toBeEnabled();
  await shot(page, "launch-line-declined");
});

test("unchosen, Jev's reading decides: conversation starts nothing and says so quietly", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 5_000) });
  await install(page, [openChoice({ recommendation: { start: false }, choice: { start: false, by: "jev", at: deadlineAt } })]);
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const line = page.locator(".launch-line");
  await expect(line).toHaveAttribute("data-state", "none");
  await expect(line).toHaveText(/^No Agent started · xMatrix read this as conversation\s*Ask an Agent$/u);
  await expect(line.getByRole("button", { name: "Ask an Agent" })).toBeEnabled();
  await shot(page, "launch-line-none");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "launch-line-none-phone");
});

test("once anything follows the message, the line is gone: the summon says who started", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(E2E_NOW) + 5_000) });
  await install(page, [openChoice({ recommendation: { start: true, harness: "codex" },
    choice: { start: true, harness: "codex", by: "jev", at: deadlineAt } })]);
  await fixtureJson(page, "first-history-followed", "**/api/xmatrix/channels/channel-general/history**", {
    messages: [
      { messageId, channelId: E2E_CHANNEL.id, sequence: 1, body, sentAt: E2E_NOW, from: E2E_USER_SENDER },
      { messageId: "message-second", channelId: E2E_CHANNEL.id, sequence: 2, body: "One more detail: it only fails on Linux",
        sentAt: E2E_NOW, from: E2E_USER_SENDER },
    ], hasMore: false,
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("One more detail: it only fails on Linux", { exact: true })).toBeVisible();
  await expect(page.locator(".launch-line")).toHaveCount(0);
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
  const choice = page.locator(".launch-line");
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
  const failed = page.locator(".launch-line[data-state='none']");
  await expect(failed).toContainText("xMatrix could not select a registered environment.");
  await expect(failed.getByRole("button", { name: "Ask an Agent" })).toBeEnabled();
  expect(await fixtureRequestBodies(page, "late-shown")).toEqual([]);
});


test("a named conversation offers its unanswered publication only after server evidence and an explicit author pick", async ({ page }) => {
  const ask = { channelId: E2E_CHANNEL.id, messageId, state: "unaddressed", canAsk: true };
  const push = await install(page, [], { metadata: {}, asks: [ask] });
  await fixtureJson(page, "ask-pick", `**/api/xmatrix/channels/channel-general/messages/${messageId}/launch-choice`, { claimed: true });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const line = page.getByRole("group", { name: "Ask an Agent", exact: true });
  await expect(line).toContainText("No Agent was asked");
  await expect(line.locator(".launch-line-count")).toHaveCount(0);
  await expect(line.getByRole("button", { name: "Ask an Agent", exact: true })).toBeEnabled();
  expect(await fixtureRequestBodies(page, "ask-pick")).toEqual([]);
  await shot(page, "message-ask-unaddressed");
  await page.reload();
  await expect(line).toBeVisible();
  expect(await fixtureRequestBodies(page, "ask-pick")).toEqual([]);
  await line.getByRole("button", { name: "Ask an Agent", exact: true }).click();
  await shot(page, "message-ask-menu");
  await page.getByRole("menu", { name: "Ask an Agent" }).getByRole("menuitem", { name: "codex" }).click();
  await expect.poll(async () => fixtureRequestBodies(page, "ask-pick")).toEqual([{ body, harness: "codex", ask: true }]);
  await launches(page, [openChoice({ open: false, choice: { start: true, harness: "codex", by: "author", at: E2E_NOW } })],
    [{ ...ask, canAsk: false }]);
  await push();
  await expect(page.locator(".launch-line[data-state='chosen']")).toContainText("codex is starting");
  await expect(line).toHaveCount(0);
  await shot(page, "message-ask-chosen");
});

test("untracked history in a named conversation does not invent a failed-delivery action", async ({ page }) => {
  await install(page, [], { metadata: {} });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(body, { exact: true })).toBeVisible();
  await expect(page.locator(".launch-line")).toHaveCount(0);
});
