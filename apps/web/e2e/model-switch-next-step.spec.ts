import type { Page } from "@playwright/test";
import * as workspace from "./workspace-fixtures";
import { test, expect } from "./fixtures";

const { E2E_CHANNEL, E2E_NOW, E2E_SPACE, E2E_USER_SENDER, fixtureJson, fixtureRequestBodies, installWorkspaceStubs } = workspace;

/* A refused `/model` is answered on the statement, and its author gets the one
   step that gets them what they asked for, in place. */
const statement = "@claude:3 /model claude-fable-5-2";
const HISTORY = `**/api/xmatrix/channels/${E2E_CHANNEL.id}/history**`;
const SEND = `**/api/xmatrix/channels/${E2E_CHANNEL.id}/messages`;

function command(sequence: number, body: string, control: Record<string, unknown>) {
  return { messageId: `switch-${sequence}`, channelId: E2E_CHANNEL.id, sequence, body, sentAt: E2E_NOW, from: E2E_USER_SENDER,
    commandResult: { controls: [{ kind: "model", target: "claude:3", ...control }] } };
}

const usedUp = command(1, statement, { status: "error",
  message: "the provider quota for claude-fable-5-2 on build-box is used up until 2026-11-19 18:00 UTC. @claude:3 stays on claude-opus-5-5.",
  quotaExhausted: { model: "claude-fable-5-2", resetsAt: "2026-11-19T18:00:00.000Z", machineName: "build-box",
    elsewhere: [{ machineName: "spare-box", harness: "claude" }] } });
const starting = command(2, statement, { status: "error", starting: true,
  message: "@claude:3 is still starting on build-box and has not connected yet. Send this again once it is running." });
const listed = command(3, "@claude:3 /model", { status: "catalog", current: "claude-opus-5-5",
  options: ["claude-opus-5-5", "claude-fable-5-2"], usedUp: [{ option: "claude-fable-5-2", resetsAt: "2026-11-19T18:00:00.000Z" }] });

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 2 });

async function openSwitches(page: Page) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [{ ...E2E_CHANNEL, messageCount: 3, historyHeadSequence: 3 }] });
  await fixtureJson(page, "switch-history", HISTORY, { messages: [usedUp, starting, listed], hasMore: false });
  await fixtureJson(page, "switch-send", SEND, {}, { method: "POST" });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  return page.locator(".app-mention-invocation");
}

test("a model whose quota is used up says until when and continues on a machine that has it", async ({ page }) => {
  const chips = await openSwitches(page);
  await chips.nth(0).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("the provider quota for claude-fable-5-2 on build-box is used up until 2026-11-19 18:00 UTC.");
  await expect(dialog).toContainText("Stops @claude:3 and hands its work to a new @claude on spare-box, where claude-fable-5-2 has quota.");
  await page.screenshot({ path: test.info().outputPath("switch-used-up.png") });
  await dialog.getByRole("button", { name: "Continue on spare-box" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Sent.");
  await expect(dialog.getByRole("button", { name: "Continue on spare-box" })).toHaveCount(0);
  await expect.poll(async () => (await fixtureRequestBodies(page, "switch-send")).map((sent) => (sent as { body?: string }).body))
    .toEqual(["@claude:3:handoff:@claude machine:spare-box model:claude-fable-5-2"]);
});

test("a switch sent to an Instance that was still starting is sent again from its answer", async ({ page }) => {
  const chips = await openSwitches(page);
  await chips.nth(1).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("@claude:3 is still starting on build-box and has not connected yet.");
  await page.screenshot({ path: test.info().outputPath("switch-starting.png") });
  await dialog.getByRole("button", { name: "Send again" }).click();
  await expect.poll(async () => (await fixtureRequestBodies(page, "switch-send")).map((sent) => (sent as { body?: string }).body))
    .toEqual([statement]);
});

test("the listed models mark the one that is used up", async ({ page }) => {
  const chips = await openSwitches(page);
  await chips.nth(2).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("2 models available; current: claude-opus-5-5; 1 used up.");
  await expect(dialog).toContainText("claude-fable-5-2 provider quota used up until");
  await expect(dialog.getByRole("button", { name: /Continue|Send again/u })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("switch-catalog.png") });
});
