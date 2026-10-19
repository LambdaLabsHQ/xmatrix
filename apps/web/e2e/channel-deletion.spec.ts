import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_SPACE, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT,
  openGeneralChannelWithHistory, fixtureRule, fixtureRequestBodies } from "./workspace-fixtures";

for (const layout of ["desktop", "mobile"] as const) {
  test(`${layout} Channel deletion requires a name and acknowledgement and retains a failed confirmation`, async ({ page }) => {
    await page.setViewportSize((layout === "desktop" ? E2E_DESKTOP_CONTEXT : E2E_MOBILE_CONTEXT).viewport);
    await openGeneralChannelWithHistory(page, E2E_CHANNEL, []);
    await fixtureRule(page, { id: "channel-delete", method: "POST",
      pattern: `**/api/xmatrix/spaces/${E2E_SPACE.id}/channels/${E2E_CHANNEL.id}/deletion`,
      responder: { kind: "sequence", responses: [
        { status: 409, json: { code: "channel_deletion_active_work", error: "Stop the Agents in this Channel first." } },
        { status: 202, json: { state: "purging" } },
      ] } });
    if (layout === "desktop") {
      await page.locator(".app-panel-header").getByRole("button", { name: `Delete #${E2E_CHANNEL.name}…` }).click();
    } else {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("button", { name: "Delete Channel…" }).click();
    }
    const dialog = page.getByRole("dialog", { name: "Delete Channel", exact: true });
    const submit = dialog.getByRole("button", { name: "Delete Channel", exact: true });
    await expect(submit).toBeDisabled();
    await dialog.getByRole("textbox").fill(E2E_CHANNEL.name!);
    await expect(submit).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await submit.click();
    await expect(dialog.getByRole("alert")).toContainText("Stop the Agents");
    await expect(dialog).toBeVisible();
    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(await fixtureRequestBodies(page, "channel-delete")).toEqual([1, 2].map(() => ({ name: E2E_CHANNEL.name, confirmation: "DELETE", acknowledge: true })));
  });
}
