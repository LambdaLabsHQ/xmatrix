import type { Page } from "@playwright/test";

import { E2E_CHANNEL, E2E_MOBILE_CONTEXT, E2E_SPACE, installWorkspaceStubs } from "./workspace-fixtures";
import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequestBodies, fixtureRule, releaseFixture } from "./in-page-api-fixtures";

test.use(E2E_MOBILE_CONTEXT);

const NOW = "2026-09-27T12:00:00.000Z";
const summary = (pageId: string, parentPageId: string | null, title: string) => ({ pageId, parentPageId, title,
  position: "V", accessMode: "open", headRevision: 3, agentSuggestOnly: false, canEdit: true, updatedAt: NOW,
  publishedAt: null });
const PAGE_TREE_PATTERN = /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u;

/** The Pages stubs every phone case here shares: a workspace with a page tree. */
async function installMobilePages(page: Page, pages: Array<ReturnType<typeof summary>>, space = E2E_SPACE) {
  await installWorkspaceStubs(page, { spaces: [space], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "page-tree", PAGE_TREE_PATTERN, { pages });
}

/** Opens the workspace on a phone and the Pages dock tab, landing on the list. */
async function openMobilePages(page: Page) {
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  const dock = page.getByRole("navigation", { name: "Primary" });
  await dock.getByRole("button", { name: "Pages" }).tap();
  const list = page.getByTestId("page-list");
  await expect(list).toContainText("Lambda Labs");
  return { dock, list };
}

// On a phone Pages works like Channels: a list, and a page is a pushed screen
// with a back bar in place of the dock; its controls are on the page itself.
test("a phone lists the pages, opens one as a pushed screen, with its controls on the page", async ({ page }) => {
  await installMobilePages(page, [summary("p-lambda", null, "Lambda Labs"), summary("p-xm", "p-lambda", "xMatrix")]);
  await fixtureJson(page, "page-document", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-xm$/u, { page: {
    ...summary("p-xm", "p-lambda", "xMatrix"), body: "# xMatrix\n\n## Status\n\nShipping.\n",
    revisionInfo: { revision: 3, kind: "edit", authors: [], conversationIds: [], createdAt: NOW } } });
  await fixtureJson(page, "page-live", /\/pages\/[^/]+\/live$/u, { protocol: "xmatrix-page-v2.ticket",
    socketPath: "/ws/pages/space-personal/p-xm", canEdit: true, headRevision: 3 });
  await fixtureJson(page, "page-claims", /\/claims$/u, { claims: [], competitiveBlocks: [] });
  await fixtureJson(page, "page-links", /\/page-links\?.*$/u, { links: [] });

  const { dock, list } = await openMobilePages(page);
  await expect(page.getByTestId("pages-view")).toHaveCount(0);

  await list.getByRole("button", { name: "xMatrix" }).click();
  await expect(page).toHaveURL(/page=p-xm/u);
  await expect(page.getByTestId("page-preview")).toContainText("Shipping.");
  await expect(page.locator(".app-topbar")).toContainText("xMatrix");
  await expect(dock).toBeHidden();

  const controls = page.getByTestId("page-controls");
  await expect(controls.getByRole("button", { name: "History" })).toBeVisible();
  await expect(controls.getByRole("button", { name: "Share" })).toBeVisible();

  await page.getByRole("button", { name: "Back to pages" }).click();
  await expect(list).toBeVisible();
  await expect(dock).toBeVisible();
  await expect(page).not.toHaveURL(/page=/u);
});

// Switching dock tabs must not rebuild each root: the panes stay mounted in
// one sliding track. The Pages list is the easiest to observe, because it is
// the one that used to be swapped out every time.
test("switching dock tabs keeps the Pages list mounted instead of reloading it", async ({ page }) => {
  await installMobilePages(page, [summary("p-lambda", null, "Lambda Labs")]);
  const { dock, list } = await openMobilePages(page);
  // A marker on the mounted node makes a rebuild observable.
  await list.evaluate((element) => element.setAttribute("data-dock-persist", "1"));

  await dock.getByRole("button", { name: "Channels" }).tap();
  await expect(dock.getByRole("button", { name: "Channels" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("page-list")).toHaveAttribute("data-dock-persist", "1");

  await dock.getByRole("button", { name: "Pages" }).tap();
  await expect(page.getByTestId("page-list")).toHaveAttribute("data-dock-persist", "1");
  await expect(list).toBeVisible();
});

// Native shells can silently decline browser prompts. Creation must use the
// same visible title form for the FAB, empty list and each parent row.
for (const entry of ["FAB", "first page", "sub-page"] as const) {
  test(`a phone creates a page from the ${entry} without a browser prompt`, async ({ page }) => {
    const parent = summary("p-lambda", null, "Lambda Labs");
    const initial = entry === "first page" ? [] : [parent];
    // A member sees the empty list; owners see the migration screen instead.
    const space = entry === "first page" ? { ...E2E_SPACE, ownerId: "another-user",
      members: E2E_SPACE.members.map((member) => ({ ...member, role: "member" })) } : E2E_SPACE;
    await installMobilePages(page, initial, space);
    await page.addInitScript(() => {
      window.prompt = () => { throw new Error("Native prompt is unavailable"); };
    });
    const created = summary("p-new", entry === "sub-page" ? parent.pageId : null, "New notes");
    await fixtureRule(page, { id: "page-create", pattern: PAGE_TREE_PATTERN, method: "POST",
      responder: { kind: "deferred", json: { page: created } } });
    await fixtureJson(page, "new-document", /\/pages\/p-new$/u, { page: {
      ...created, body: "# New notes\n",
      revisionInfo: { revision: 3, kind: "edit", authors: [], conversationIds: [], createdAt: NOW } } });

    if (entry === "first page") {
      await page.goto("/app", { waitUntil: "domcontentloaded" });
      await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Pages" }).tap();
      await page.getByRole("button", { name: "Create the first page" }).tap();
    } else {
      const { list } = await openMobilePages(page);
      if (entry === "sub-page") await list.getByRole("button", { name: "New sub-page" }).tap();
      else await page.locator(".app-mobile-create-fab").tap();
    }
    const dialog = page.getByRole("dialog", { name: entry === "sub-page" ? "New sub-page" : "New page", exact: true });
    await expect(dialog).toBeVisible();
    const title = dialog.getByLabel("Title", { exact: true });
    await expect(title).toBeFocused();
    const submit = dialog.getByRole("button", { name: "Create", exact: true });
    await expect(submit).toBeDisabled();
    await title.fill("   ");
    await expect(submit).toBeDisabled();
    expect(await fixtureRequestBodies(page, "page-create")).toEqual([]);
    await title.fill("  New notes  ");
    await fixtureJson(page, "updated-tree", PAGE_TREE_PATTERN, { pages: [...initial, created] }, { method: "GET" });
    await submit.tap();
    await expect(submit).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    // Enter while the first request is pending cannot create a second page.
    await page.keyboard.press("Enter");
    await expect.poll(() => fixtureRequestBodies(page, "page-create")).toEqual([
      { title: "New notes", parentPageId: created.parentPageId },
    ]);
    await releaseFixture(page, "page-create");
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/page=p-new/u);
    await page.getByRole("button", { name: "Back to pages" }).tap();
    await expect(page.getByTestId("page-list").getByRole("button", { name: "New notes" })).toBeVisible();
  });
}

test("a phone can cancel creation and retry a failed creation without losing the title", async ({ page }) => {
  await installMobilePages(page, [summary("p-lambda", null, "Lambda Labs")]);
  await fixtureJson(page, "failed-create", PAGE_TREE_PATTERN, { error: "Could not create the page" },
    { method: "POST", status: 500 });
  await openMobilePages(page);
  const create = page.locator(".app-mobile-create-fab");
  await create.tap();
  const dialog = page.getByRole("dialog", { name: "New page", exact: true });
  await dialog.getByLabel("Title", { exact: true }).fill("Cancelled notes");
  await dialog.getByRole("button", { name: "Cancel" }).tap();
  await expect(dialog).toBeHidden();
  expect(await fixtureRequestBodies(page, "failed-create")).toEqual([]);
  await create.tap();
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Title", { exact: true }).fill("Retry notes");
  await dialog.getByRole("button", { name: "Create", exact: true }).tap();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("Retry notes");
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await fixtureJson(page, "retry-create", PAGE_TREE_PATTERN,
    { page: summary("p-retry", null, "Retry notes") }, { method: "POST" });
  await dialog.getByRole("button", { name: "Create", exact: true }).tap();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/page=p-retry/u);
  expect(await fixtureRequestBodies(page, "failed-create")).toHaveLength(1);
  expect(await fixtureRequestBodies(page, "retry-create")).toEqual([{ title: "Retry notes", parentPageId: null }]);
});
