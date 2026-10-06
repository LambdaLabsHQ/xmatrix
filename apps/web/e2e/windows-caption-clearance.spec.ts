import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { E2E_CHANNEL, channelHistoryFixture, openGeneralChannelWithHistory } from "./workspace-fixtures";

/* The Windows desktop shell overlays minimize/maximize/close on the page's
   top-right corner (titleBarOverlay, 36px high, ~138px wide at 100%). Headless
   Chromium has no window controls overlay, so the band env(titlebar-area-*)
   would report is stated directly. */
const CAPTION = { width: 138, height: 36 };

async function openAsWindowsDesktop(page: Page, width: number) {
  await page.setViewportSize({ width, height: 820 });
  await page.addInitScript((caption) => {
    (window as unknown as Record<string, unknown>).xmatrixDesktop = {
      client: "desktop", platform: "win32",
      getContext: async () => ({ client: "desktop", platform: "win32", version: "0.16.600" }),
      setBadge: async () => undefined, setTitle: async () => undefined,
      notify: async () => true, openExternal: async () => undefined,
      checkCliInstalled: async () => ({ installed: true }),
      getUpdateStatus: async () => ({ state: "disabled", enabled: false }),
    };
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = `.xmatrix-app.xmatrix-desktop-windows {
        --xmatrix-windows-caption-height: ${caption.height}px !important;
        --xmatrix-windows-caption-width: ${caption.width}px !important;
      }`;
      document.head.appendChild(style);
    });
  }, CAPTION);
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, channelHistoryFixture(8, "caption"));
  await expect(page.locator(".xmatrix-app.xmatrix-desktop-windows .app-workspace-panel")).toBeVisible();
}

/** Visible controls and planks whose box reaches under the caption buttons. */
async function underCaption(page: Page) {
  return page.evaluate((caption) => {
    const left = window.innerWidth - caption.width;
    const hits: string[] = [];
    const selector = "button, a, input, textarea, select, [role='button'], [contenteditable='true'], .app-detail-plank, .app-tool-surface";
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (!element.closest(".xmatrix-app")) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (getComputedStyle(element).visibility === "hidden") continue;
      if (box.right > left && box.top < caption.height && box.bottom > 0) {
        hits.push(`${element.tagName.toLowerCase()}.${String(element.className).split(" ").slice(0, 3).join(".")} "${(element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 24)}" @${Math.round(box.left)},${Math.round(box.top)}`);
      }
    }
    return hits;
  }, CAPTION);
}

for (const width of [1100, 1400, 1700]) {
  test(`Windows caption buttons cover no control at ${width}px`, async ({ page }) => {
    await openAsWindowsDesktop(page, width);

    const rail = await page.locator(".app-rail").boundingBox();
    const panel = await page.locator(".app-workspace-panel").boundingBox();
    expect(rail && panel && Math.round(panel.y)).toBe(rail && Math.round(rail.y));

    expect(await underCaption(page), "conversation").toEqual([]);

    const destinations = page.locator(".app-rail button[aria-label]");
    const labels = await destinations.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label") || ""));
    for (const label of labels) {
      if (/log ?out|sign out|help|feedback|search/i.test(label)) continue;
      await page.locator(`.app-rail button[aria-label="${label}"]`).click();
      await page.waitForTimeout(400);
      expect(await underCaption(page), label).toEqual([]);
      await page.keyboard.press("Escape");
    }
  });
}
