import type { Page } from "@playwright/test";
import type { FixtureResponder } from "./in-page-api-fixtures";
import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_SPACE, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT,
  openGeneralChannelWithHistory, fixtureRule, fixtureRequestBodies, releaseFixture } from "./workspace-fixtures";

for (const layout of ["desktop", "mobile"] as const) {
  test(`${layout} Channel deletion confirms stopping Agents and waits for termination`, async ({ page }) => {
    await page.setViewportSize((layout === "desktop" ? E2E_DESKTOP_CONTEXT : E2E_MOBILE_CONTEXT).viewport);
    await openGeneralChannelWithHistory(page, E2E_CHANNEL, []);
    await fixtureRule(page, { id: "channel-delete", method: "POST",
      pattern: `**/api/xmatrix/spaces/${E2E_SPACE.id}/channels/${E2E_CHANNEL.id}/deletion`,
      responder: { kind: "sequence", responses: [
        { status: 409, json: { code: "channel_deletion_active_work", error: "Stop the Agents in this Channel first." } },
        { status: 409, json: { code: "channel_deletion_active_work", error: "Agents are still stopping." } },
        { status: 202, json: { state: "purging" } },
      ] } });
    await stopRule(page, { kind: "deferred", json: {} });
    if (layout === "desktop") {
      // The title icon is the only delete control on a desktop.
      await expect(page.getByRole("button", { name: "Delete Channel…", exact: true })).toHaveCount(0);
      await page.locator(".app-panel-header").getByRole("button", { name: `Delete #${E2E_CHANNEL.name}…` }).click();
    } else {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("button", { name: "Delete Channel…" }).click();
    }
    const dialog = page.getByRole("dialog", { name: `Delete #${E2E_CHANNEL.name}?`, exact: true });
    const submit = dialog.getByRole("button", { name: "Delete", exact: true });
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await submit.click();
    await expect(dialog).toContainText("Stop all of them and delete it?");
    expect(await fixtureRequestBodies(page, "channel-stop")).toEqual([]);
    await dialog.getByRole("button", { name: "Stop Agents and Delete", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("Waiting for the Agents to stop");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    expect(await fixtureRequestBodies(page, "channel-delete")).toHaveLength(1);
    await releaseFixture(page, "channel-stop");
    await expect(dialog).toHaveCount(0);
    expect(await fixtureRequestBodies(page, "channel-delete")).toEqual([1, 2, 3].map(() => ({ name: E2E_CHANNEL.name, confirmation: "DELETE", acknowledge: true })));
    expect(await fixtureRequestBodies(page, "channel-stop")).toEqual([{ body: "/stop all", clientMessageId: expect.any(String) }]);
  });
}

// These cases protect the confirmation boundary and recovery in the actual UI;
// the Hub's existing stop/deletion tests own authorization and daemon receipts.
async function stopRule(page: Page, responder: FixtureResponder) {
  await fixtureRule(page, { id: "channel-stop", method: "POST",
    pattern: `**/api/xmatrix/channels/${E2E_CHANNEL.id}/messages`, responder });
}

async function openDeletion(page: Page, code = "channel_deletion_active_work") {
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, []);
  await fixtureRule(page, { id: "channel-delete", method: "POST",
    pattern: `**/api/xmatrix/spaces/${E2E_SPACE.id}/channels/${E2E_CHANNEL.id}/deletion`,
    responder: { kind: "static", status: 409, json: { code, error: "The Channel changed." } } });
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Delete Channel…" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete #${E2E_CHANNEL.name}?`, exact: true });
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  return dialog;
}

test("cancelling the stop confirmation leaves Agents running", async ({ page }) => {
  const dialog = await openDeletion(page);
  await stopRule(page, { kind: "static", json: {} });
  await expect(dialog).toContainText("Stop all of them and delete it?");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await fixtureRequestBodies(page, "channel-stop")).toEqual([]);
  expect(await fixtureRequestBodies(page, "channel-delete")).toHaveLength(1);
});

test("another deletion refusal cannot offer to stop Agents", async ({ page }) => {
  const dialog = await openDeletion(page, "channel_deletion_changed");
  await expect(dialog.getByRole("alert")).toContainText("The Channel changed");
  await expect(dialog.getByRole("button", { name: "Stop Agents and Delete" })).toHaveCount(0);
});

test("a failed stop append retries the same command before deleting", async ({ page }) => {
  const dialog = await openDeletion(page);
  await stopRule(page, { kind: "sequence", responses: [
    { status: 503, json: { code: "unavailable", error: "Try again." } }, { json: {} },
  ] });
  const confirm = dialog.getByRole("button", { name: "Stop Agents and Delete", exact: true });
  await confirm.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(await fixtureRequestBodies(page, "channel-delete")).toHaveLength(1);
  await fixtureRule(page, { id: "deletion-after-stop", method: "POST",
    pattern: `**/api/xmatrix/spaces/${E2E_SPACE.id}/channels/${E2E_CHANNEL.id}/deletion`,
    responder: { kind: "static", status: 202, json: { state: "purging" } } });
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  const bodies = await fixtureRequestBodies(page, "channel-stop");
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual({ body: "/stop all", clientMessageId: expect.any(String) });
  expect(bodies[1]).toEqual(bodies[0]);
});

test("unfinished termination times out without claiming deletion", async ({ page }) => {
  const dialog = await openDeletion(page);
  await stopRule(page, { kind: "static", json: {} });
  await page.clock.install();
  await dialog.getByRole("button", { name: "Stop Agents and Delete", exact: true }).click();
  await expect.poll(async () => (await fixtureRequestBodies(page, "channel-delete")).length).toBeGreaterThan(1);
  await page.clock.fastForward(30_001);
  await expect(dialog.getByRole("alert")).toContainText("took too long");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await expect(dialog).toBeVisible();
});
