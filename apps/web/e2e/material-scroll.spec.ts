import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
});

test("scrolls slab material in the same native content coordinate system", async ({ page }, testInfo) => {
  const channels = Array.from({ length: 48 }, (_, index) => ({
    ...E2E_CHANNEL,
    id: `channel-material-${index}`,
    name: `material-${String(index).padStart(2, "0")}`,
    updatedAt: `2026-07-01T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
  }));

  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels });

  const slab = page.locator(".app-sidebar");
  // The column shows one list; its viewport is the only scroller.
  const viewport = slab.locator('.app-sidebar-pane-body.app-material-scroll-viewport');
  const material = viewport.locator(":scope > .app-material-scroll-content");
  await expect(material).toBeVisible();
  await expect(slab.getByText("material-23", { exact: true })).toBeVisible();
  const showMore = slab.getByRole("button", { name: /^Show more/ });
  while (await showMore.count()) await showMore.click();
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  for (const theme of ["wood"]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-app-theme", value), theme);
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });

    const before = await material.evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      texture: getComputedStyle(element, "::before").content,
      texturePosition: getComputedStyle(element, "::before").backgroundPosition,
    }));
    // The desktop column is paper inside the workspace panel: no grain sheet
    // rides its scroller. The sheet still moves with the rows wherever it is
    // drawn, which is what the rest of this test holds.
    expect(before.texture).toBe("none");

    await viewport.evaluate((element) => {
      element.scrollTop = 180;
    });
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(180);

    const after = await material.evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      texturePosition: getComputedStyle(element, "::before").backgroundPosition,
    }));

    expect(after.top - before.top).toBeCloseTo(-180, 0);
    expect(after.texturePosition).toBe(before.texturePosition);
    await expect(slab).not.toHaveAttribute("style", /--app-slab-scroll/);

    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const screenshotPath = testInfo.outputPath(`sidebar-material-${theme}.png`);
    await slab.screenshot({ path: screenshotPath });
    testInfo.attachments.push({ name: `sidebar-material-${theme}`, path: screenshotPath, contentType: "image/png" });
  }
});
