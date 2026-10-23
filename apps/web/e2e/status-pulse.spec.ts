import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

/* Status is a pulse line. A break runs along it while an Agent in the Space
   works; otherwise, and under reduced motion, the line is whole. */

test.use(E2E_DESKTOP_CONTEXT);

const pulse = (page: import("@playwright/test").Page) =>
  page.locator('.app-rail button[aria-label="Status"] .app-status-pulse');

/** Compare two painted positions, without making the SVG/CSS implementation
 * or its animation property the contract. The icon must visibly keep moving. */
async function paintedPulseAt(page: import("@playwright/test").Page, time: number) {
  await pulse(page).evaluate((icon, at) => {
    for (const animation of icon.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = at;
    }
  }, time);
  const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  return pulse(page).screenshot({ animations: "allow", path: test.info().outputPath(`pulse-${time}-${reduced}.png`) });
}

test("the Status line rests whole while no Agent works", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await expect(pulse(page)).toBeVisible();
  await expect(pulse(page)).not.toHaveAttribute("data-live");
  const first = await paintedPulseAt(page, 500);
  const second = await paintedPulseAt(page, 1000);
  expect(first.equals(second)).toBe(true);
});

test("a break runs along the Status line while an Agent works", async ({ page }) => {
  const space = workingAgentsSpace(1, "pulse");
  await openWorkingAgentsSpace(page, space, channelHistory(1, "pulse-message", () => "Working on it"), "Working on it");
  await expect(pulse(page)).toHaveAttribute("data-live", "true");
  const first = await paintedPulseAt(page, 500);
  const second = await paintedPulseAt(page, 1000);
  expect(first.equals(second)).toBe(false);

  await page.emulateMedia({ reducedMotion: "reduce" });
  const resting = await paintedPulseAt(page, 500);
  expect(resting.equals(await paintedPulseAt(page, 1000))).toBe(true);
  expect(resting.equals(first)).toBe(false);
});
