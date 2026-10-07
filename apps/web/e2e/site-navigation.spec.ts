import { expect, test } from "@playwright/test";

for (const width of [393, 820, 1440]) {
  test(`navigation logo glass follows scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const glass = page.locator(".site-navbar-brand-glass");
    await expect(glass).toHaveCSS("opacity", "0");

    await page.evaluate(() => window.scrollTo(0, 600));
    await expect(glass).toHaveCSS("opacity", "1");
    const surface = glass.locator('[data-material="liquid-glass-pill"]');
    await expect(surface).toBeVisible();
    await expect.poll(() => surface.evaluate((element) => getComputedStyle(element).backdropFilter)).toContain("url(");
    const logo = page.getByRole("link", { name: "xMatrix home", exact: true });
    const logoBounds = (await logo.boundingBox())!;
    const glassBounds = (await glass.boundingBox())!;
    expect(glassBounds.x).toBeLessThanOrEqual(logoBounds.x);
    expect(glassBounds.y).toBeLessThanOrEqual(logoBounds.y);
    expect(glassBounds.x + glassBounds.width).toBeGreaterThanOrEqual(logoBounds.x + logoBounds.width);
    expect(glassBounds.y + glassBounds.height).toBeGreaterThanOrEqual(logoBounds.y + logoBounds.height);
    await expect(logo).toBeVisible();
    await logo.click();
    await expect(glass).toHaveCSS("opacity", "0");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.scrollTo(0, 25));
    await expect(glass).toHaveCSS("opacity", "1");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(glass).toHaveCSS("opacity", "0");
  });
}

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
        await sheet.getByRole("link", { name: "Setup", exact: true }).click();
        await expect(sheet).toBeHidden();
      } else {
        await header.getByRole("link", { name: "Setup", exact: true }).click();
      }

      await expect(page).toHaveURL(/\/#how-it-works$/);
      const title = page.getByRole("heading", { name: "Install xMatrix", exact: true });
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
