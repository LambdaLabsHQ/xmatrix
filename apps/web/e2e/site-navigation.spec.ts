import { expect, test } from "@playwright/test";

test("the home page shows connectors with loaded icons and no nested glass", async ({ page }) => {
  await page.goto("/");
  const list = page.getByRole("list", { name: "Connectors", exact: true });
  await list.scrollIntoViewIfNeeded();
  await expect(list).toBeVisible();
  expect(await list.getByRole("listitem").count()).toBeGreaterThan(0);
  for (const item of await list.getByRole("listitem").all()) {
    const icon = item.locator("img");
    await expect(icon).toBeVisible();
    await expect.poll(() => icon.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    expect(await item.evaluate((element) =>
      element.parentElement?.closest(".app-liquid-glass-surface") !== null)).toBe(false);
  }
});

test("the guide serves every page, and every link inside it reaches a section that exists", async ({ page }) => {
  await page.goto("/docs");
  const guide = page.getByRole("navigation", { name: "Guide" });
  const pages = await guide.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")!));
  expect(pages.length).toBeGreaterThan(3);
  const targets = new Set<string>();
  const titles = new Set<string>();
  for (const href of pages) {
    await page.goto(href);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // What a search result and a shared link show is this page's own, not the site's.
    // Inside <head>, where every crawler reads it (next.config.ts htmlLimitedBots).
    const head = (selector: string) => page.locator(`head ${selector}`).getAttribute(selector.startsWith("link") ? "href" : "content");
    const title = await page.title();
    const description = (await head('meta[name="description"]'))!;
    titles.add(title);
    expect(title.length, title).toBeLessThanOrEqual(62);
    expect(description.length, description).toBeGreaterThan(80);
    expect(description.length, description).toBeLessThanOrEqual(158);
    expect(new URL((await head('link[rel="canonical"]'))!).pathname).toBe(href);
    expect(new URL((await head('meta[property="og:url"]'))!).pathname).toBe(href);
    expect(await head('meta[property="og:title"]')).toBe(title);
    expect(await head('meta[property="og:description"]')).toBe(description);
    const graph = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!)["@graph"];
    expect(new URL(graph[0].url).pathname).toBe(href);
    expect(new URL(graph[1].itemListElement.at(-1).item).pathname).toBe(href);
    await expect(guide.locator('[aria-current="page"]')).toHaveAttribute("href", href);
    for (const link of await page.locator(".docs-article a, .docs-toc a").evaluateAll((links) =>
      links.map((element) => new URL((element as HTMLAnchorElement).href)))) {
      if (link.origin === new URL(page.url()).origin && link.pathname.startsWith("/docs")) targets.add(link.pathname + link.hash);
    }
  }
  expect(titles.size).toBe(pages.length);
  for (const target of targets) {
    const [path, section] = target.split("#");
    expect(pages, target).toContain(path);
    if (!section) continue;
    await page.goto(target);
    await expect(page.locator(`[id="${decodeURIComponent(section)}"]`), target).toBeAttached();
  }
});

test("the guide is a paper document: no wood or glass around its text, and a phone does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs/syntax");
  const article = page.locator(".docs-article");
  await expect(article.getByRole("table").first()).toBeVisible();
  expect(await page.locator(".docs-shell").locator('[data-material], .app-liquid-glass-surface').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // The same definition a page in the app is drawn with.
  await expect(article).toHaveClass(/page-document/);
  await page.goto("/docs/project-wiki");
  const examples = page.locator(".docs-article pre:has(code.language-text)");
  await expect(examples.first()).toBeVisible();
  for (const example of await examples.all()) {
    expect(await example.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
  }
});

for (const width of [393, 820, 1440]) {
  test(`navigation logo glass follows scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const glass = page.locator(".site-navbar-brand-glass");
    await expect(glass).toHaveCSS("opacity", "0");

    // The final small scroll back to zero must not retain partial opacity.
    await page.evaluate(() => window.scrollTo(0, 2));
    await expect.poll(() => glass.evaluate((element) => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0);
    await page.evaluate(() => window.scrollTo(0, 1));
    await expect.poll(() => glass.evaluate((element) => Number(getComputedStyle(element).opacity))).toBeCloseTo(1 / 120, 5);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(glass).toHaveCSS("opacity", "0");

    await page.evaluate(() => window.scrollTo(0, 600));
    await expect(glass).toHaveCSS("opacity", "1");
    // Finish the smooth scroll initiated by this test before navigating home.
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(600);
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
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
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
        expect(background).toMatch(/\/textures\/wood\.[0-9a-f]{10}\.webp/);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      if (width < 1024) {
        await header.getByRole("button", { name: "Open navigation menu" }).click();
        const sheet = page.locator(".site-nav-sheet");
        await expect(sheet).toBeVisible();
        await sheet.getByRole("link", { name: "Pricing", exact: true }).click();
        await expect(sheet).toBeHidden();
      } else {
        await header.getByRole("link", { name: "Pricing", exact: true }).click();
      }

      await expect(page).toHaveURL(/\/#pricing$/);
      const title = page.getByRole("heading", { name: "People pay. Agents don't.", exact: true });
      // Sticky header stays put; land the pricing heading just below it. The
      // sections above it can still settle, so realign before each check.
      await expect.poll(async () => title.evaluate((element) => {
        const nav = document.querySelector(".site-navbar")!;
        window.scrollTo(
          0,
          window.scrollY + element.getBoundingClientRect().top - nav.getBoundingClientRect().bottom - 8,
        );
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2));
      })).toBe(true);
      await expect.poll(async () => header.evaluate((element) => element.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
      await expect(title).toBeInViewport();
    }
  });
}
