import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_SPACE, installWorkspaceStubs, openWorkspaceWithStubs } from "./workspace-fixtures";
import { fixtureJson } from "./in-page-api-fixtures";

/* The mobile wood topbar is the workspace identity bar. On a dock tab's own
   screen (Pages, Channels, Agents, More) it names only the Space, because the
   dock right below already says which tab this is; that tab's + sits just above the dock.
   A screen pushed from More still needs the bar as its title: the in-pane
   heading of a paper destination is display:none under md, so dropping the
   view label there would leave screens like Activity or Settings unlabelled. */

test.use({ viewport: { width: 390, height: 844 } });

const topbar = (page: import("@playwright/test").Page) => page.locator(".app-topbar");

test("every dock tab's topbar names only the Space, and the tab's + sits just above the dock", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u, { pages: [{
    pageId: "p-home", parentPageId: null, title: "Home", position: "V", accessMode: "open", headRevision: 1,
    agentSuggestOnly: false, canEdit: true, updatedAt: "2026-09-27T12:00:00.000Z", publishedAt: null }] });
  await page.goto("/app", { waitUntil: "domcontentloaded" });

  const bar = topbar(page);
  const dock = page.getByRole("navigation", { name: "Primary" });
  for (const [tab, create] of [["Channels", "New conversation"], ["Pages", "New page"], ["Agents", "New agent"],
    ["More", null]] as const) {
    await dock.getByRole("button", { name: tab }).tap();
    await expect(bar).toContainText(E2E_SPACE.name);
    await expect(bar).not.toContainText(tab);
    await expect(bar.getByRole("button", { name: /^New / })).toHaveCount(0);
    const fab = page.locator(".app-mobile-create-fab");
    if (create) {
      await expect(fab).toHaveAccessibleName(create);
      const [fabBox, dockBox] = [await fab.boundingBox(), await dock.boundingBox()];
      expect(fabBox).not.toBeNull();
      expect(dockBox).not.toBeNull();
      expect(dockBox!.x + dockBox!.width / 2).toBeCloseTo(390 / 2, 0);
      // The dock and the + share a right edge, with 12px clearance. The bar is the
      // board itself, screen edge to screen edge; its glyphs sit 1.25rem inside the dock's edges.
      expect(dockBox!.y - (fabBox!.y + fabBox!.height)).toBeCloseTo(12, 0);
      expect(fabBox!.x + fabBox!.width).toBeCloseTo(dockBox!.x + dockBox!.width, 0);
      const barBox = (await page.locator(".app-topbar").boundingBox())!;
      expect(barBox.x).toBe(0);
      expect(barBox.width).toBe(390);
      const searchBox = (await page.locator(".app-topbar .app-mobile-search-icon svg").boundingBox())!;
      expect(dockBox!.x + dockBox!.width - (searchBox.x + searchBox.width)).toBeCloseTo(20, 0);
      const paint = await fab.evaluate((button) => {
        const style = getComputedStyle(button);
        const dockStyle = getComputedStyle(document.querySelector(".app-mobile-tab-dock")!);
        const plankStyle = getComputedStyle(document.querySelector(".app-topbar")!);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        context.fillStyle = style.backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return {
          fill: Array.from(context.getImageData(0, 0, 1, 1).data),
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          backdrop: style.backdropFilter,
          plankBackgroundColor: plankStyle.backgroundColor,
          plankBackgroundImage: plankStyle.backgroundImage,
          dockBackdrop: dockStyle.backdropFilter,
          dockBackgroundImage: dockStyle.backgroundImage,
        };
      });
      // The + is the same opaque plank as the top bar, not the dock's glass.
      expect(paint.backgroundColor).toBe(paint.plankBackgroundColor);
      expect(paint.backgroundImage).toBe(paint.plankBackgroundImage);
      expect(paint.backgroundImage).not.toBe(paint.dockBackgroundImage);
      expect(paint.backdrop).toBe("none");
      expect(paint.dockBackdrop).not.toBe("none");
      // Opaque warm wood, not a translucent white fill and not charcoal.
      expect(paint.fill[3]).toBe(255);
      expect(paint.fill[0]).toBeGreaterThan(paint.fill[2]);
      expect(paint.fill[0]).toBeGreaterThan(160);
    } else await expect(fab).toHaveCount(0);
  }
  /* No title plank between the bar and the list either. */
  await dock.getByRole("button", { name: "Channels" }).tap();
  await expect(page.locator(".app-mobile-channel-list-pane").getByText("Channels", { exact: true })).toHaveCount(0);
});

test("channel detail keeps the list bar's height, safe area and shadowless edge", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [{ ...E2E_CHANNEL, summary: "Review the mobile layout." }] });

  await page.locator(".xmatrix-app-shell").evaluate((shell) => {
    (shell as HTMLElement).style.setProperty("--mobile-topbar-safe-top", "59px");
  });
  const bar = topbar(page);
  const listBox = (await bar.boundingBox())!;
  expect(listBox).toMatchObject({ x: 0, y: 0, width: 390, height: 119 });
  await expect(bar).toHaveCSS("box-shadow", "none");

  await page.locator(".app-mobile-channel-list-pane").getByText("general", { exact: true }).first().tap();

  await expect(bar).toContainText("general");
  /* The title alone names the conversation: no Space or member count under it. */
  await expect(bar).not.toContainText(E2E_SPACE.name);
  await expect(bar).not.toContainText("online");
  /* Left-aligned right after the back chevron, in the list bar's title type. */
  const title = bar.locator(".app-mobile-bar-title");
  const [backBox, titleBox] = await Promise.all([bar.locator(".app-mobile-topbar-back").boundingBox(),
    title.boundingBox()]);
  expect(titleBox!.x - (backBox!.x + backBox!.width)).toBeLessThanOrEqual(8);
  await expect(title).toHaveCSS("font-size", "20px");
  expect(await bar.boundingBox()).toEqual(listBox);
  await expect(bar).toHaveCSS("box-shadow", "none");
  const summary = page.locator(".app-mobile-channel-about");
  await expect(summary).toHaveCSS("background-image", "none");
  await expect(summary).toHaveCSS("box-shadow", "none");
});

test("other views keep their label, since the topbar is their only title", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app/personal-sspaceperso/activity");

  const bar = topbar(page);
  await expect(bar).toContainText("Activity");
  await expect(bar).toContainText(E2E_SPACE.name);
});


test("create button clears native dock height and safe area, including older shells", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  // Exercise the native layout against both its fallback and live height updates.
  await page.locator(".xmatrix-app-shell").evaluate((shell) => {
    shell.classList.add("xmatrix-app-native-dock");
    (shell as HTMLElement).style.setProperty("--mobile-bottom-safe", "34px");
  });
  const fab = page.locator(".app-mobile-create-fab");
  for (const height of [null, 64, 83]) {
    await page.evaluate((height) => {
      if (height === null) document.documentElement.style.removeProperty("--app-native-tab-bar-height");
      else document.documentElement.style.setProperty("--app-native-tab-bar-height", `${height}px`);
    }, height);
    const box = await fab.boundingBox();
    expect(box).not.toBeNull();
    const dockTop = 844 - 34 - (height ?? 49);
    expect(dockTop - (box!.y + box!.height)).toBeCloseTo(12, 0);
  }
});

test("the bar's and the lists' content line and the + follow the native dock's measured edge", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.locator(".xmatrix-app-shell").evaluate((shell) => {
    shell.classList.add("xmatrix-app-native-dock");
  });
  const fab = page.locator(".app-mobile-create-fab");
  const search = page.locator(".app-topbar .app-mobile-search-icon svg");
  const time = page.locator(".app-mobile-chat-row .app-channel-row-time").first();
  // Before the shell reports its dock, everything keeps the web dock's edge; after, the native one's.
  for (const [width, inset] of [[390, null], [390, 28], [430, 21], [360, 12]] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate((inset) => {
      if (inset === null) document.documentElement.style.removeProperty("--app-native-dock-inset");
      else document.documentElement.style.setProperty("--app-native-dock-inset", `${inset}px`);
    }, inset);
    // The web dock's side gap: clamp(0.875rem, 3.6vw, 1.125rem).
    const edge = width - (inset ?? Math.min(18, Math.max(14, width * 0.036)));
    await expect.poll(async () => {
      const [fabBox, searchBox, timeRight] = await Promise.all([fab.boundingBox(), search.boundingBox(),
        time.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().right;
        })]);
      if (!fabBox || !searchBox) return Infinity;
      return Math.max(Math.abs(fabBox.x + fabBox.width - edge), Math.abs(searchBox.x + searchBox.width + 20 - edge),
        Math.abs(timeRight + 20 - edge));
    }).toBeLessThan(0.5);
  }
});
