import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import {
  fixtureChannelCatalog,
  fixtureJson,
  installApiFixtures,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

/* End-to-end coverage for the mobile workspace switcher (redesigned in
   a5c909c1). These tests exist because the previous implementation had a
   pure-CSS failure mode no source-level test could catch: the sheet was
   rendered inside the topbar, whose backdrop-filter creates a containing
   block, so the fixed-position sheet never reached the viewport and the
   backdrop collapsed into a small square. The geometry assertions below
   fail on that implementation and pass on the portal-based one. */

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
const sheet = (page: Page) => page.locator('[data-slot="sheet-content"]');
const overlay = (page: Page) => page.locator('[data-slot="sheet-overlay"]');

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
    /* A real tap target, not a squashed icon: full row height, wide. */
    const box = await entry.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(box!.width).toBeGreaterThanOrEqual(200);
  });

  test("tapping the entry opens a true bottom sheet, not a layer trapped in the topbar", async ({
    page,
  }) => {
    await openWorkspace(page);
    await trigger(page).tap();

    const content = sheet(page);
    await expect(content).toBeVisible();
    await expect(content.getByRole("heading", { name: "Switch workspace" })).toBeVisible();

    /* Regression guard for the backdrop-filter containing-block bug: the
       sheet must be portaled out of the topbar... */
    await expect(page.locator('header.app-topbar [data-slot="sheet-content"]')).toHaveCount(0);

    /* ...and must be anchored to the bottom edge of the real viewport,
       clear of the Dynamic Island / status bar at the top. */
    const box = await content.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(VIEWPORT.height - 2);
    expect(box!.y).toBeGreaterThan(VIEWPORT.height / 3);
    expect(box!.width).toBeGreaterThanOrEqual(VIEWPORT.width - 8);

    /* The scrim covers the screen instead of collapsing into a small square
       (the first screenshot regression). */
    const scrim = await overlay(page).boundingBox();
    expect(scrim).not.toBeNull();
    expect(scrim!.width).toBeGreaterThanOrEqual(VIEWPORT.width - 2);
    expect(scrim!.height).toBeGreaterThanOrEqual(VIEWPORT.height - 2);
  });

  test("sheet lists every Space in one list with member counts and the active space", async ({
    page,
  }) => {
    await openWorkspace(page);
    await trigger(page).tap();

    const list = page.getByRole("listbox", { name: "Workspaces" });
    await expect(list).toBeVisible();

    const options = list.getByRole("option");
    await expect(options).toHaveCount(2);
    await expect(options.filter({ hasText: "Personal" })).toContainText("1 member");
    await expect(options.filter({ hasText: "Lambda Labs" })).toContainText("3 members");

    /* Exactly one space is marked current, with the check indicator. */
    const active = list.locator('[role="option"][aria-selected="true"]');
    await expect(active).toHaveCount(1);
    await expect(active.locator("svg.lucide-check")).toBeVisible();
  });

  test("selecting another space switches to it and closes the sheet", async ({ page }) => {
    await openWorkspace(page);

    const entry = trigger(page);
    await entry.tap();

    const list = page.getByRole("listbox", { name: "Workspaces" });
    /* Spaces are listed by name, so the app opens in Lambda Labs. */
    const targetName = "Personal";
    const target = list.getByRole("option", { name: targetName });
    await target.tap();

    await expect(sheet(page)).toBeHidden();
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

  test("tapping the scrim dismisses the sheet without switching", async ({ page }) => {
    await openWorkspace(page);

    const entry = trigger(page);
    const before = (await entry.textContent()) ?? "";
    await entry.tap();
    await expect(sheet(page)).toBeVisible();

    /* Tap the top of the screen (over the scrim, far from the sheet). */
    await overlay(page).tap({ position: { x: 196, y: 80 } });
    await expect(sheet(page)).toBeHidden();
    await expect(entry).toHaveText(before);
  });

  test("with a single space there is no switcher entry", async ({ page }) => {
    await installApiFixtures(page);
    await fixtureJson(page, "api-catch-all", "**/api/xmatrix/**", {});
    await fixtureJson(page, "channels", /\/api\/xmatrix\/channels(?:\?.*)?$/, { channels: [] });
    await fixtureChannelCatalog(page, "channel-catalog", []);
    await fixtureJson(page, "spaces", "**/api/xmatrix/spaces**", { spaces: [TEAM_SPACE] });
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
