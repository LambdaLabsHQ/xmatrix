import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

const AGENTS = 1000;
const REPORTS_PER_SECOND = 100;
const SECONDS = 10;

test.use(E2E_DESKTOP_CONTEXT);
const space = workingAgentsSpace(AGENTS, "k");
const messages = channelHistory(40, "k-message", (row) => `Row ${row}: a **status** update with \`code\` and a list:\n\n- one\n- two`);

/**
 * The client must keep up with a Space of a thousand working Agents even when
 * nothing upstream thins their reports (docs: 架构与性能 page, track A). Every
 * report arrives the way the Hub sends it to a client without digests: the
 * Agent card and the whole Channel. The page must process them all without
 * saturating the main thread. Wall-clock, so it runs in the serial
 * performance project; the bound is loose enough for a loaded CI host and is
 * tightened as track A lands.
 */
test("a thousand Agents reporting do not saturate the main thread", async ({ page }) => {
  test.setTimeout(120_000);
  const send = await openWorkingAgentsSpace(page, space, messages, "Row 40:");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]),
  );
  await page.evaluate(() => {
    const record = { longTasks: 0, longestMs: 0 };
    (window as unknown as { __longTasks: typeof record }).__longTasks = record;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        record.longTasks += 1;
        record.longestMs = Math.max(record.longestMs, entry.duration);
      }
    }).observe({ type: "longtask" });
  });
  const before = await metrics();
  const startedAt = Date.now();
  let sent = 0;
  for (let tick = 0; tick < SECONDS * 10; tick += 1) {
    for (let burst = 0; burst < REPORTS_PER_SECOND / 10; burst += 1) {
      const index = 1 + (sent % (AGENTS - 1));
      const activity = `Step ${sent}`;
      sent += 1;
      for (const frame of space.report(index, activity)) send(frame);
    }
    await page.waitForTimeout(Math.max(0, startedAt + (tick + 1) * 100 - Date.now()));
  }
  await page.waitForTimeout(500);
  const after = await metrics();
  const elapsed = (Date.now() - startedAt) / 1000;
  const longTasks = await page.evaluate(() =>
    (window as unknown as { __longTasks: { longTasks: number; longestMs: number } }).__longTasks);
  const busy = (after.TaskDuration - before.TaskDuration) / elapsed;
  console.log(`[thousand-agents] ${sent} reports in ${elapsed.toFixed(1)}s: ${JSON.stringify({
    mainThreadBusy: Number(busy.toFixed(3)),
    script: Number((after.ScriptDuration - before.ScriptDuration).toFixed(2)),
    style: Number((after.RecalcStyleDuration - before.RecalcStyleDuration).toFixed(2)),
    layout: Number((after.LayoutDuration - before.LayoutDuration).toFixed(2)),
    ...longTasks,
  })}`);

  expect(sent).toBe(REPORTS_PER_SECOND * SECONDS);
  expect(busy).toBeLessThan(0.8);
});
