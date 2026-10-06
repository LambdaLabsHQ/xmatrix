import { expect, test } from "@playwright/test";

for (const width of [393, 820, 1440]) {
  test(`public navigation does not obscure content at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });

    for (const route of ["/", "/docs", "/download"]) {
      await page.goto(route);
      const header = page.locator(".site-navbar");
      await expect(header).toBeVisible();
      // WoodPanel must keep its baked grain tile on every public page.
      for (const panel of await page.locator('[data-material="wood-panel"]').all()) {
        const background = await panel.evaluate((element) => getComputedStyle(element).backgroundImage);
        expect(background).toContain("/textures/wood.webp");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      if (width < 1024) {
        await header.getByRole("button", { name: "Open navigation menu" }).click();
        const sheet = page.locator(".site-nav-sheet");
        await expect(sheet).toBeVisible();
        await sheet.getByRole("link", { name: "How it Works", exact: true }).click();
        await expect(sheet).toBeHidden();
      } else {
        await header.getByRole("link", { name: "How it Works", exact: true }).click();
      }

      await expect(page).toHaveURL(/\/#how-it-works$/);
      const title = page.getByRole("heading", { name: "Connect your workspace", exact: true });
      // Sticky header stays put; land the installation panel just below it.
      await title.evaluate((element) => {
        const panel = element.closest('[data-material="wood-panel"]')!;
        const nav = document.querySelector(".site-navbar")!;
        window.scrollTo(
          0,
          window.scrollY + panel.getBoundingClientRect().top - nav.getBoundingClientRect().bottom - 8,
        );
      });
      await expect.poll(async () => header.evaluate((element) => element.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
      await expect(title).toBeInViewport();
      await expect.poll(async () => title.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2));
      })).toBe(true);
    }
  });
}
