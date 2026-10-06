import type { Page } from "@playwright/test";

import { E2E_CHANNEL, E2E_MOBILE_CONTEXT, E2E_SPACE, installWorkspaceStubs } from "./workspace-fixtures";
import { expect, test } from "./fixtures";
import { fixtureJson } from "./in-page-api-fixtures";

test.use(E2E_MOBILE_CONTEXT);

const NOW = "2026-09-27T12:00:00.000Z";
const summary = (pageId: string, parentPageId: string | null, title: string) => ({ pageId, parentPageId, title,
  position: "V", accessMode: "open", headRevision: 3, agentSuggestOnly: false, canEdit: true, updatedAt: NOW,
  publishedAt: null });
const PAGE_TREE_PATTERN = /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u;

/** The Pages stubs every phone case here shares: a workspace with a page tree. */
async function installMobilePages(page: Page, pages: Array<ReturnType<typeof summary>>) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
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
