import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import {
  fixtureChannelCatalog,
  fixtureJson,
  fixtureSpaceResources,
  installApiFixtures,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

/* End-to-end coverage for the mobile workspace switcher: the Space sign
   unfolds into a plank of Spaces. The plank is portaled out of the topbar
   (whose backdrop-filter would make it a containing block and trap a fixed
   layer) and laid over the sign, so the geometry assertions below check it
   starts exactly where the sign is and its scrim covers the screen. */

const VIEWPORT = { width: 393, height: 852 };
const NOW = "2026-07-01T00:00:00.000Z";

function member(userId: string, name: string, role: string) {
  return { userId, email: `${userId}@xmatrix.test`, name, role, joinedAt: NOW };
}

const PERSONAL_SPACE = {
  id: "space-personal",
  name: "Personal",
  ownerId: "e2e-user",
  members: [member("e2e-user", "E2E Tester", "owner")],
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const TEAM_SPACE = {
  id: "space-team",
  name: "Lambda Labs",
  ownerId: "e2e-user",
  members: [
    member("e2e-user", "E2E Tester", "owner"),
    member("user-2", "Yiming", "member"),
    member("user-3", "Legend", "member"),
  ],
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const openWorkspace = (page: Page) =>
  openWorkspaceWithStubs(page, { spaces: [PERSONAL_SPACE, TEAM_SPACE] });

const trigger = (page: Page) => page.getByRole("button", { name: "Switch workspace" });
const plank = (page: Page) => page.locator(".app-mobile-space-plank");
const scrim = (page: Page) => page.locator(".app-mobile-space-plank-scrim");

test.describe("mobile workspace switcher", () => {
  test("topbar entry shows the current workspace and is tappable", async ({ page }) => {
    await openWorkspace(page);

    const entry = trigger(page);
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute("aria-haspopup", "dialog");
    await expect(entry).toHaveAttribute("aria-expanded", "false");

    /* The entry names the current space, so the switcher is discoverable
       (the "现在怎么切" complaint was an invisible entry point). */
    await expect(entry).toContainText(/Personal|Lambda Labs/);
    /* A real tap target, not a squashed icon: the whole Space sign. */
    const box = await entry.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(120);
  });

  test("tapping the sign unfolds a plank from the sign itself", async ({ page }) => {
    await openWorkspace(page);
    const entry = trigger(page);
    const sign = await entry.boundingBox();
    await entry.tap();

    const content = plank(page);
    await expect(content).toBeVisible();
    await expect(content).toHaveAttribute("aria-label", "Switch workspace");
    await expect(page.locator(".app-topbar .app-mobile-space-plank")).toHaveCount(0);

    /* The board starts on the sign (the current Space stays on the sign's
       line) and opens down and out from it. */
    await expect.poll(async () => {
      const box = await content.boundingBox();
      return box && sign ? [Math.round(box.x - sign.x), Math.round(box.y - sign.y),
        box.width >= sign.width, box.height > sign.height * 2] : null;
    }).toEqual([0, 0, true, true]);
    const current = content.locator('[role="option"][aria-selected="true"]');
    const row = await current.boundingBox();
    expect(Math.abs(row!.y - sign!.y)).toBeLessThanOrEqual(1);

    const cover = await scrim(page).boundingBox();
    expect(cover!.width).toBeGreaterThanOrEqual(VIEWPORT.width - 2);
    expect(cover!.height).toBeGreaterThanOrEqual(VIEWPORT.height - 2);
  });

  test("plank lists every Space, the current one first on the sign's line", async ({
    page,
  }) => {
    await openWorkspace(page);
    await trigger(page).tap();

    const list = page.getByRole("listbox", { name: "Workspaces" });
    await expect(list).toBeVisible();

    const options = list.getByRole("option");
    await expect(options).toHaveCount(2);
    /* Spaces are listed by name, so the app opens in Lambda Labs. */
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await expect(options.first()).toContainText("Lambda Labs");
    await expect(options.first().locator("svg.lucide-building")).toBeVisible();
    await expect(options.filter({ hasText: "Personal" })).toContainText("1 member");
    await expect(list.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  });

  test("selecting another space switches to it and folds the plank", async ({ page }) => {
    await openWorkspace(page);

    const entry = trigger(page);
    await entry.tap();

    const list = page.getByRole("listbox", { name: "Workspaces" });
    /* Spaces are listed by name, so the app opens in Lambda Labs. */
    const targetName = "Personal";
    const target = list.getByRole("option", { name: targetName });
    await target.tap();

    await expect(plank(page)).toBeHidden();
    /* Switching lands on the target space's channel list and the entry now
       names the newly selected space. */
    await expect(entry).toContainText(targetName);
    await expect(entry).not.toContainText("Lambda Labs");
    await expect(page).toHaveURL(/\/channels$/);

    /* Reopening shows the selection moved. */
    await entry.tap();
    const active = page
      .getByRole("listbox", { name: "Workspaces" })
      .locator('[role="option"][aria-selected="true"]');
    await expect(active).toHaveCount(1);
    await expect(active).toContainText(targetName);
  });

  test("tapping the paper or the sign folds the plank without switching", async ({ page }) => {
    await openWorkspace(page);

    const entry = trigger(page);
    const before = (await entry.textContent()) ?? "";
    await entry.tap();
    await expect(plank(page)).toBeVisible();

    /* Tap the paper below the plank. */
    await scrim(page).tap({ position: { x: 196, y: 600 } });
    await expect(plank(page)).toBeHidden();
    await expect(entry).toHaveText(before);

    /* The current Space on the sign's line folds it too. */
    await entry.tap();
    await plank(page).locator('[role="option"][aria-selected="true"]').tap();
    await expect(plank(page)).toBeHidden();
    await expect(entry).toHaveText(before);
  });

  test("with a single space there is no switcher entry", async ({ page }) => {
    await installApiFixtures(page);
    await fixtureJson(page, "api-catch-all", "**/api/xmatrix/**", {});
    await fixtureJson(page, "channels", /\/api\/xmatrix\/channels(?:\?.*)?$/, { channels: [] });
    await fixtureChannelCatalog(page, "channel-catalog", []);
    await fixtureJson(page, "spaces", "**/api/xmatrix/spaces**", { spaces: [TEAM_SPACE] });
    await fixtureSpaceResources(page);
    await page.goto("/app");

    await expect(page.locator(".app-mobile-title")).toBeVisible();
    await expect(trigger(page)).toHaveCount(0);
  });
});

test.describe("desktop", () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 2,
  });

  test("the mobile switcher entry is hidden on desktop viewports", async ({ page }) => {
    await openWorkspace(page);
    /* Wait until the shell has rendered (desktop always shows the rail),
       then assert the mobile entry is not shown. */
    await expect(page.locator(".app-rail")).toBeVisible();
    await expect(trigger(page)).toBeHidden();
  });
});
