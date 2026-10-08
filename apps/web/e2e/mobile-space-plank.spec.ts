import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use({ viewport: { width: 390, height: 844 } });

const TEAM_SPACE = {
  ...E2E_SPACE,
  id: "space-team",
  name: "Lambda Labs",
  createdAt: E2E_NOW,
  updatedAt: E2E_NOW,
};

// Every dock root confines wood to the left Space name panel while leaving
// the status area and the search side on paper.
for (const tab of ["channels", "status", "pages"]) {
  test(`the ${tab} tab names the Space on a wood plank`, async ({ page }) => {
    await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE, TEAM_SPACE], channels: [E2E_CHANNEL] });
    await page.goto(`/app/${TEAM_SPACE.id}/${tab}`);
    const bar = page.locator(".app-topbar.app-mobile-tab-root-bar");
    await expect(bar.getByText("Lambda Labs")).toBeVisible();
    const panel = bar.locator(".app-mobile-space-trigger");
    await expect(bar).toHaveCSS("background-image", "none");
    await expect(bar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(panel).toHaveText("Lambda Labs");
    const material = await panel.evaluate((el) => {
      const style = getComputedStyle(el);
      return { image: style.backgroundImage, filter: style.backdropFilter };
    });
    expect(material.image).toContain("url(");
    expect(material.filter).toBe("none");
    const panelBox = (await panel.boundingBox())!;
    const searchBox = (await bar.locator(".app-mobile-search-icon svg").boundingBox())!;
    expect(panelBox.x).toBeGreaterThan(0);
    expect(panelBox.x + panelBox.width).toBeLessThan(searchBox.x);
    await expect(panel).toHaveCSS("border-radius", "12px");
    await page.locator(".xmatrix-app-shell").evaluate((shell) => {
      (shell as HTMLElement).style.setProperty("--mobile-topbar-safe-top", "59px");
    });
    expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual(59);
    await page.screenshot({ path: `/tmp/space-plank-${tab}.png` });
    await panel.tap();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
}
