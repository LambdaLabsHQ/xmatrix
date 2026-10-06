import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { E2E_CHANNEL, channelHistoryFixture, openGeneralChannelWithHistory } from "./workspace-fixtures";

/* The window frame (globals.css "The window frame"): the wood rail and the
   paper panel run to the window's edges, one 52px band runs across the top,
   and each platform keeps one inset clear. Headless Chromium has no traffic
   lights, no full screen and no safe-area insets, so each is stated: the
   lights' rectangle from MAC_TRAFFIC_LIGHT_POSITION, full screen through the
   bridge's event, and the iPad insets through the variables env() feeds. */
const VIEWPORT = { width: 1440, height: 900 };
const BAND = 52;
const LIGHTS = { x: 12, y: 19, width: 14 * 3 + 7 * 2, height: 14 };

type FullScreenListener = (fullScreen: boolean) => void;

async function openAsMacDesktop(page: Page, { fullScreen = false } = {}) {
  await page.setViewportSize(VIEWPORT);
  await page.addInitScript((initial) => {
    const listeners = new Set<FullScreenListener>();
    const state = window as unknown as Record<string, unknown>;
    state.__setFullScreen = (next: boolean) => listeners.forEach((listener) => listener(next));
    state.xmatrixDesktop = {
      client: "desktop", platform: "darwin",
      getContext: async () => ({ client: "desktop", platform: "darwin", version: "0.16.600" }),
      setBadge: async () => undefined, setTitle: async () => undefined,
      notify: async () => true, openExternal: async () => undefined,
      checkCliInstalled: async () => ({ installed: true }),
      checkForUpdates: async () => undefined,
      getUpdateStatus: async () => ({ state: "downloaded", enabled: true, currentVersion: "0.16.600", version: "9.9.9" }),
      installUpdate: async () => {
        state.__installs = Number(state.__installs ?? 0) + 1;
        return { state: "installing", enabled: true, version: "9.9.9" };
      },
      getFullScreen: async () => initial,
      onFullScreenChange: (listener: FullScreenListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }, fullScreen);
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, channelHistoryFixture(6, "frame"));
  await expect(page.locator(".xmatrix-app.xmatrix-desktop-macos .app-workspace-panel")).toBeVisible();
}

async function box(page: Page, selector: string) {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} has no box`);
  return found;
}

const centreY = (rect: { y: number; height: number }) => rect.y + rect.height / 2;

/** The rail and the paper reach every window edge, with nothing between them. */
async function expectFlushToWindow(page: Page) {
  const rail = await box(page, ".app-rail");
  const panel = await box(page, ".app-workspace-panel");
  expect([rail.x, rail.y, rail.y + rail.height]).toEqual([0, 0, VIEWPORT.height]);
  expect([panel.x, panel.y, panel.x + panel.width, panel.y + panel.height])
    .toEqual([rail.width, 0, VIEWPORT.width, VIEWPORT.height]);
  const radii = await page.evaluate(() =>
    [".app-rail", ".app-workspace-panel"].map((selector) =>
      getComputedStyle(document.querySelector(selector)!).borderRadius));
  expect(radii).toEqual(["0px", "0px"]);
}

/** Headers that share the band's centre line, given where the band starts. */
async function expectHeadersOnBand(page: Page, bandTop: number) {
  const band = bandTop + BAND / 2;
  for (const selector of [".app-sidebar-space-header", ".app-space-switcher-trigger", ".app-panel-header"]) {
    expect(Math.abs(centreY(await box(page, selector)) - band), selector).toBeLessThanOrEqual(1);
  }
}

/** Visible controls whose box reaches into the rectangle. */
async function controlsIn(page: Page, rect: { x: number; y: number; width: number; height: number }) {
  return page.evaluate((area) => {
    const hits: string[] = [];
    // The sidebar's resize grip is an edge the height of the window by design.
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("button:not([aria-label='Resize sidebar']), a, input, textarea, [role='button'], [contenteditable='true']"))) {
      const found = element.getBoundingClientRect();
      if (found.width === 0 || found.height === 0 || getComputedStyle(element).visibility === "hidden") continue;
      if (found.right > area.x && found.left < area.x + area.width && found.bottom > area.y && found.top < area.y + area.height) {
        hits.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 24)}" @${Math.round(found.left)},${Math.round(found.top)} ${Math.round(found.width)}x${Math.round(found.height)}`);
      }
    }
    return hits;
  }, rect);
}

test("in a browser the rail and paper run to the window's edges under one band", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, channelHistoryFixture(6, "frame"));
  await expect(page.locator(".app-workspace-panel")).toBeVisible();

  await expectFlushToWindow(page);
  expect((await box(page, ".app-rail")).width).toBe(64);
  await expectHeadersOnBand(page, 0);
  expect(Math.abs(centreY(await box(page, ".app-rail-user-avatar")) - BAND / 2)).toBeLessThanOrEqual(1);
});

test("on macOS the traffic lights sit centred on the rail and cover nothing", async ({ page }) => {
  await openAsMacDesktop(page);

  await expectFlushToWindow(page);
  const rail = await box(page, ".app-rail");
  expect(rail.width).toBe(LIGHTS.x * 2 + LIGHTS.width);
  expect(Math.abs(centreY(LIGHTS) - BAND / 2)).toBeLessThanOrEqual(1);
  await expectHeadersOnBand(page, 0);
  expect(await controlsIn(page, { x: 0, y: 0, width: rail.width, height: BAND })).toEqual([]);

  /* A downloaded update asks for a restart with a rail button laid out by
     the rail: centred on it, above the bottom actions, clear of the others. */
  await expect(page.locator(".app-rail .app-rail-update")).toHaveAttribute(
    "aria-label",
    "Restart to update to xMatrix 9.9.9",
  );
  const update = await box(page, ".app-rail .app-rail-update");
  expect(Math.abs(update.x + update.width / 2 - rail.width / 2)).toBeLessThanOrEqual(1);
  const overlaps = await page.evaluate(() => {
    const bead = document.querySelector(".app-rail .app-rail-update")!.getBoundingClientRect();
    return Array.from(document.querySelectorAll(".app-rail button:not(.app-rail-update)"))
      .map((button) => button.getBoundingClientRect())
      .filter((other) => other.bottom > bead.top && other.top < bead.bottom).length;
  });
  expect(overlaps).toBe(0);

  /* Restarting closes every window, so the button asks first. */
  const installs = () => page.evaluate(() => Number((window as unknown as Record<string, unknown>).__installs ?? 0));
  const confirm = page.getByRole("dialog", { name: "Restart to update?" });
  await page.locator(".app-rail .app-rail-update").click();
  await expect(confirm).toContainText("0.16.600 → 9.9.9");
  await confirm.getByRole("button", { name: "Later" }).click();
  await expect(confirm).toBeHidden();
  expect(await installs()).toBe(0);
  await page.locator(".app-rail .app-rail-update").click();
  await confirm.getByRole("button", { name: "Restart" }).click();
  await expect.poll(installs).toBe(1);

  /* Docs and feedback share the rail's one Help button. */
  await page.getByRole("button", { name: "Help" }).click();
  const help = page.getByRole("menu", { name: "Help" });
  await expect(help.getByRole("menuitem", { name: "Documentation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
});

test("macOS full screen drops the lights' band when the shell reports it", async ({ page }) => {
  await openAsMacDesktop(page);
  const app = page.locator(".xmatrix-app.xmatrix-desktop-macos").first();
  await expect(app).not.toHaveClass(/xmatrix-desktop-fullscreen/);

  await page.evaluate(() => (window as unknown as { __setFullScreen: (next: boolean) => void }).__setFullScreen(true));
  await expect(app).toHaveClass(/xmatrix-desktop-fullscreen/);
  await expectFlushToWindow(page);
  expect((await box(page, ".app-rail")).width).toBe(64);
  expect(Math.abs(centreY(await box(page, ".app-rail-user-avatar")) - BAND / 2)).toBeLessThanOrEqual(1);
  await expectHeadersOnBand(page, 0);

  await page.evaluate(() => (window as unknown as { __setFullScreen: (next: boolean) => void }).__setFullScreen(false));
  await expect(app).not.toHaveClass(/xmatrix-desktop-fullscreen/);
  expect((await box(page, ".app-rail")).width).toBe(LIGHTS.x * 2 + LIGHTS.width);
});

test("a window already in full screen opens without the lights' band", async ({ page }) => {
  await openAsMacDesktop(page, { fullScreen: true });
  await expect(page.locator(".xmatrix-app.xmatrix-desktop-macos").first()).toHaveClass(/xmatrix-desktop-fullscreen/);
  expect((await box(page, ".app-rail")).width).toBe(64);
});

test("on iPad the materials run under the status bar and home indicator while content stays inside", async ({ page }) => {
  const viewport = { width: 1180, height: 820 };
  const inset = { top: 24, bottom: 20 };
  await page.setViewportSize(viewport);
  await page.addInitScript((value) => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = `.xmatrix-app { --app-safe-area-top: ${value.top}px !important; --app-safe-area-bottom: ${value.bottom}px !important; }`;
      document.head.appendChild(style);
    });
  }, inset);
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, channelHistoryFixture(6, "frame"));
  await expect(page.locator(".app-workspace-panel")).toBeVisible();

  const rail = await box(page, ".app-rail");
  const panel = await box(page, ".app-workspace-panel");
  expect([rail.y, rail.y + rail.height, panel.y, panel.y + panel.height]).toEqual([0, viewport.height, 0, viewport.height]);
  await expectHeadersOnBand(page, inset.top);
  expect(await controlsIn(page, { x: 0, y: 0, width: viewport.width, height: inset.top })).toEqual([]);
  expect(await controlsIn(page, { x: 0, y: viewport.height - inset.bottom, width: viewport.width, height: inset.bottom })).toEqual([]);
});
