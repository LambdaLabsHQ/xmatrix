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

  test("the channel glyph switches visibility and the actions sit as icons after the name", async ({ page }) => {
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
    await expect(header.getByText("Public", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Actions for #general" })).toHaveCount(0);
    await expect(header.getByRole("button", { name: "Copy channel link" })).toBeVisible();
    await expect(header.getByRole("button", { name: /Move #general/u })).toHaveCount(0);

    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain("private");
      void dialog.accept();
    });
    await header.getByRole("button", { name: "Make #general private" }).click();
    await expect.poll(() => fixtureRequestBodies(page, "visibility-patch")).toEqual([{ mode: "closed" }]);
    await expect(header.getByRole("button", { name: "Make #general public" })).toBeVisible();
    await expect(header.getByText("Private", { exact: true })).toHaveCount(0);
  });

  test("members who cannot change visibility still read it from the glyph", async ({ page }) => {
    const space = {
      ...E2E_SPACE,
      members: [{ ...E2E_SPACE.members[0], role: "member" }],
    };
    const channel = { ...E2E_CHANNEL, createdBy: "someone-else" };
    await installWorkspaceStubs(page, { spaces: [space], channels: [channel] });
    await page.goto(channelPath, { waitUntil: "domcontentloaded" });

    const header = page.locator(".app-panel-header");
    await expect(header.getByLabel("#general is public")).toBeVisible();
    await expect(header.getByRole("button", { name: /Make #general/u })).toHaveCount(0);
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
