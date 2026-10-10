import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

/* Status is a pulse line. A break runs along it while an Agent in the Space
   works; otherwise, and under reduced motion, the line is whole. */

test.use(E2E_DESKTOP_CONTEXT);

const pulse = (page: import("@playwright/test").Page) =>
  page.locator('.app-rail button[aria-label="Status"] .app-status-pulse');

const trace = (page: import("@playwright/test").Page) => pulse(page).locator("path").evaluate((path) => {
  const style = getComputedStyle(path);
  return { animation: style.animationName, dashes: style.strokeDasharray };
});

test("the Status line rests whole while no Agent works", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await expect(pulse(page)).toBeVisible();
  await expect(pulse(page)).not.toHaveAttribute("data-live");
  expect(await trace(page)).toEqual({ animation: "none", dashes: "none" });
});

test("a break runs along the Status line while an Agent works", async ({ page }) => {
  const space = workingAgentsSpace(1, "pulse");
  await openWorkingAgentsSpace(page, space, channelHistory(1, "pulse-message", () => "Working on it"), "Working on it");
  await expect(pulse(page)).toHaveAttribute("data-live", "true");
  expect(await trace(page)).toEqual({ animation: "app-status-pulse-break", dashes: "0.84px, 0.16px" });

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await trace(page)).toEqual({ animation: "none", dashes: "none" });
});
