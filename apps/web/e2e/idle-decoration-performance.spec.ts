import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, conversationOpened } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";
import { rendererBudget } from "./renderer-budget";
import { routeNativeHumanSocket } from "./native-human-socket-fixture";

test.use({ ...E2E_DESKTOP_CONTEXT, trace: "off", humanSocketWorker: true });

/** The loaded-work budget cannot detect clocks waking an otherwise idle
 * renderer: their iterations can coincide with work already in progress.
 * Keep normal motion and bound style updates in its own quiet window. The
 * unchanged hint and illumination effects still have iteration boundaries;
 * individual dots and rings must not add repeated style sampling. */
test("working decorations keep an idle renderer below ten percent without repeated style updates", async ({ page }) => {
  const space = workingAgentsSpace(1009, "k", { focusedInstances: 10, intent: "Review channels and message performance" });
  await openWorkingAgentsSpace(page, space, channelHistory(40, "k-message", row => `Row ${row}: **status**`), "Row 40:",
    { routeSocket: routeNativeHumanSocket });
  await conversationOpened(page);
  await expect(page.locator(".app-agent-work-intent:not(.app-agent-work-intent-stale)")).toHaveCount(10);
  await page.waitForLoadState("networkidle");
  await delay(2000);
  const budget = await rendererBudget(page);
  await delay(10000);
  const measured = await budget.total();
  console.log(`[idle-decoration] ${JSON.stringify(measured)}`);
  expect(measured.busy).toBeLessThan(0.1);
  expect(measured.styleUpdates).toBeLessThanOrEqual(90);
});
