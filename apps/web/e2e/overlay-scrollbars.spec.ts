import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

// Headless Chromium already hides its scrollbars, so the probe in the root
// layout finds no gutter; the cases switch overlay mode on as Windows would.
test("a scroller shows a floating thumb while it moves, which fades, widens and drags", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-overlay-scrollbars", "");
    for (const [id, hidden] of [["overlay-list", false], ["hidden-strip", true]] as const) {
      const list = document.createElement("div");
      list.id = id;
      list.style.cssText = "position:fixed;left:40px;top:40px;width:300px;height:400px;overflow-y:auto;z-index:50;background:white";
      if (hidden) list.style.setProperty("scrollbar-width", "none");
      list.innerHTML = Array.from({ length: 4 }, (_, i) => `<div style="height:400px">row ${i}</div>`).join("");
      document.body.appendChild(list);
    }
  });
  const thumb = page.locator(".overlay-scrollbar-thumb[data-axis='y']");
  await expect(page.locator("#overlay-list")).toHaveCSS("scrollbar-width", "auto");

  await page.locator("#hidden-strip").evaluate((element) => { element.scrollTop = 200; });
  await page.locator("#overlay-list").evaluate((element) => { element.scrollTop = 600; });
  await expect(thumb).toHaveCount(1);
  await expect(thumb).toHaveAttribute("data-visible", "");
  const box = (await thumb.boundingBox())!;
  // A quarter of the track, at the right edge, half way along what can scroll.
  expect(box.x + box.width).toBeCloseTo(340, 0);
  expect(box.height).toBeCloseTo((400 - 4) / 4, 0);
  expect(box.y).toBeCloseTo(40 + 2 + ((400 - 4) * 3 / 4) * (600 / 1200), 0);

  // Held under the pointer it stays and drags; a quarter track moves a third of the scroll.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 99);
  await page.mouse.up();
  await expect.poll(() => page.locator("#overlay-list").evaluate((element) => element.scrollTop)).toBeGreaterThan(990);
  await page.waitForTimeout(1200);
  await expect(thumb).toHaveAttribute("data-visible", "");

  await page.mouse.move(600, 600);
  await expect(thumb).toHaveCount(0, { timeout: 3000 });
});
