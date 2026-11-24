import { expect, test } from "./fixtures";
import { E2E_MOBILE_CONTEXT, conversationOpened } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

test.use({ ...E2E_MOBILE_CONTEXT });

/* The phone's Channel details sheet covers the whole screen. The conversation
   under it keeps its rows and scroll position but must not paint or animate:
   its glass and work dock kept the iOS compositor busy behind an opaque sheet. */
test("the conversation under the phone's Channel details sheet stops animating and comes back where it was", async ({ page }) => {
  const space = workingAgentsSpace(3, "c", { focusedInstances: 3, intent: "Review channels" });
  const messages = channelHistory(60, "c-message", (row) => `Row ${row}: **status**`);
  const send = await openWorkingAgentsSpace(page, space, messages, "Row 60:");
  await conversationOpened(page);
  const surface = page.locator(".app-message-surface");
  const runningUnder = () => surface.evaluate((element) => element.getAnimations({ subtree: true })
    .filter((animation) => animation.playState === "running").length);
  await expect.poll(runningUnder).toBeGreaterThan(0);

  const scroller = surface.locator("[data-virtuoso-scroller]").first();
  await scroller.evaluate((element) => element.scrollBy(0, -600));
  const scrolledTo = await scroller.evaluate((element) => element.scrollTop);

  await page.locator(".app-mobile-channel-more-button").tap();
  const details = page.getByRole("dialog", { name: "Channel details" });
  await expect(details).toBeVisible();
  await expect(surface).toHaveJSProperty("inert", true);
  await expect.poll(runningUnder).toBe(0);
  await expect(surface).toHaveCSS("content-visibility", "hidden");

  // Presence keeps arriving while the sheet is open.
  for (const frame of space.report(0, "Still working")) send(frame);

  await details.getByRole("button", { name: "Back to channel", exact: true }).tap();
  await expect(details).toHaveCount(0);
  await expect(surface).toHaveJSProperty("inert", false);
  await expect(surface).toHaveCSS("content-visibility", "visible");
  await expect.poll(runningUnder).toBeGreaterThan(0);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(scrolledTo);
});
