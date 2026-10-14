import { setTimeout as delay } from "node:timers/promises";
import { rendererBudget } from "./renderer-budget";
import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, conversationOpened } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

const FOCUSED_INSTANCES = 10;
const SECONDS = 8;

test.use({ ...E2E_DESKTOP_CONTEXT, trace: "off" });

/**
 * A page nobody touches, with working Agents in view: ten share the open
 * conversation, each with its pulse, ring and shimmer, and the list shows
 * the dots of everyone else at work. Their loops run on the compositor.
 *
 * What is asserted is how often the main thread restyles the page, which
 * does not depend on the machine. The loops ask for none of it: a page that
 * is told of every turn of every loop restyles about ten times a second here,
 * one that is not only as often as the composer's hint turns over.
 */
test("working Agents at rest cost the page no frames of their own", async ({ page }) => {
  test.setTimeout(90_000);
  const space = workingAgentsSpace(60, "k", { focusedInstances: FOCUSED_INSTANCES, intent: "Review channels and message performance" });
  const history = channelHistory(12, "k-message", (row) => `Row ${row}: a status update.`);
  await openWorkingAgentsSpace(page, space, history, "Row 12:");
  await conversationOpened(page);
  await expect(page.locator(".app-agent-work-intent:not(.app-agent-work-intent-stale)")).toHaveCount(FOCUSED_INSTANCES);
  await page.waitForLoadState("networkidle");
  await delay(2_000);

  const measured = await rendererBudget(page);
  await delay(SECONDS * 1_000);
  const spent = await measured.total();
  console.log(`[idle-animation] ${SECONDS}s at rest: ${JSON.stringify(spent)}`);
  expect(spent.styleUpdates).toBeLessThanOrEqual(SECONDS * 4);
});
