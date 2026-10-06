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

// The bar naming the Space is the same wood plank on every dock tab. On a
// tool page (Agents, Pages) a layered glass fill used to win over it and left
// a white pill on the paper.
for (const tab of ["channels", "agents", "pages"]) {
  test(`the ${tab} tab names the Space on a wood plank`, async ({ page }) => {
    await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE, TEAM_SPACE], channels: [E2E_CHANNEL] });
    await page.goto(`/app/${TEAM_SPACE.id}/${tab}`);
    const bar = page.locator(".app-topbar.app-mobile-tab-root-bar");
    await expect(bar.getByText("Lambda Labs")).toBeVisible();
    const material = await bar.evaluate((el) => {
      const style = getComputedStyle(el);
      return { image: style.backgroundImage, filter: style.backdropFilter };
    });
    expect(material.image).toContain("url(");
    expect(material.filter).toBe("none");
    await page.screenshot({ path: `/tmp/space-plank-${tab}.png` });
  });
}
