import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_MOBILE_CONTEXT,
  E2E_SPACE,
  installWorkspaceStubs,
} from "./workspace-fixtures";

const channelPath = "/app/personal-sspaceperso/channels/general-cchannelgen";

test.describe("desktop", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("visibility moves from the title into the overflow menu", async ({ page }) => {
    const closed = { ...E2E_CHANNEL, mode: "closed" };
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
    await fixtureJson(
      page,
      "visibility-patch",
      "**/api/xmatrix/channels/channel-general",
      { channel: closed },
      { method: "PATCH" }
    );
    await page.goto(channelPath, { waitUntil: "domcontentloaded" });

    const header = page.locator(".app-panel-header");
    await expect(header.getByText("general", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose visibility for #general" })).toHaveCount(0);
    await expect(header.getByText("Public", { exact: true })).toHaveCount(0);

    const menuButton = page.getByRole("button", { name: "Actions for #general" });
    await menuButton.click();
    const menu = page.getByRole("menu", { name: "Actions for #general" });
    const publicChoice = menu.getByRole("menuitemradio", { name: "Public" });
    const privateChoice = menu.getByRole("menuitemradio", { name: "Private" });
    await expect(publicChoice).toBeVisible();
    await expect(privateChoice).toBeVisible();
    await expect(publicChoice).toHaveAttribute("aria-checked", "true");
    await expect(privateChoice).toHaveAttribute("aria-checked", "false");
    await expect(menu.getByRole("menuitem", { name: "Move to another Space" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy channel link" })).toBeVisible();

    await publicChoice.click();
    await expect(menu).toBeHidden();
    expect(await fixtureRequestBodies(page, "visibility-patch")).toEqual([]);

    await menuButton.click();
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain("private");
      void dialog.accept();
    });
    await privateChoice.click();
    await expect.poll(() => fixtureRequestBodies(page, "visibility-patch")).toEqual([{ mode: "closed" }]);

    await menuButton.click();
    await expect(menu.getByRole("menuitemradio", { name: "Private" })).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByRole("menuitemradio", { name: "Public" })).toHaveAttribute("aria-checked", "false");
    await expect(header.getByText("Private", { exact: true })).toHaveCount(0);
  });

  test("members who cannot change visibility still see the current mode in the menu", async ({ page }) => {
    const space = {
      ...E2E_SPACE,
      members: [{ ...E2E_SPACE.members[0], role: "member" }],
    };
    const channel = { ...E2E_CHANNEL, createdBy: "someone-else" };
    await installWorkspaceStubs(page, { spaces: [space], channels: [channel] });
    await page.goto(channelPath, { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("button", { name: "Choose visibility for #general" })).toHaveCount(0);
    await page.getByRole("button", { name: "Actions for #general" }).click();
    const menu = page.getByRole("menu", { name: "Actions for #general" });
    await expect(menu.getByText("Public", { exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
  });
});

test.describe("mobile", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("the channel title does not show a visibility badge", async ({ page }) => {
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
    await page.goto(channelPath, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Choose visibility for #general" })).toHaveCount(0);
    await expect(page.locator(".app-mobile-bar-title")).toHaveText("general");
    await expect(page.locator(".app-topbar").getByText("Public", { exact: true })).toHaveCount(0);
  });
});
