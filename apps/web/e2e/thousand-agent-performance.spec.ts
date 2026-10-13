import { setTimeout as delay } from "node:timers/promises";
import { installRenderCounter } from "./render-counts";
import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, conversationOpened } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

const AGENTS = 1000;
const REPORTS_PER_SECOND = 100;
const SECONDS = 60;

test.use({ ...E2E_DESKTOP_CONTEXT, trace: "off" });
const space = workingAgentsSpace(AGENTS, "k");
const messages = channelHistory(40, "k-message", (row) => `Row ${row}: a **status** update with \`code\` and a list:\n\n- one\n- two`);

type Traffic = { counting: boolean; reports: number; snapshots: number; last: number };

/** Absolute renderer TaskDuration, including normal animations and delivery.
 * Every report retains the legacy Hub pair (Agent card + whole Channel), at
 * 100 reports/s for a full minute. Ten percent of reports target the open
 * Channel, the rest exercise the thousand-Channel catalog. Each ten-second
 * window must meet the same budget: neither idle subtraction nor a long drain
 * can disguise sustained work or socket loss. Playwright DOM snapshots are
 * excluded because they walk the whole page on every test action; CDP still
 * accounts for all product script, style, layout and native renderer work.
 */
test("a thousand Agents stay below ten percent sustained main-thread work", async ({ page }) => {
  test.setTimeout(150_000);
  await installRenderCounter(page);
  await page.addInitScript(() => {
    const traffic: Traffic = { counting: false, reports: 0, snapshots: 0, last: -1 };
    (window as unknown as { __loadTraffic: Traffic }).__loadTraffic = traffic;
    // Observe the fixture's normal DOM MessageEvent delivery after the app's
    // listeners return; do not replace WebSocket or add per-frame CDP calls.
    const dispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (event) {
      const result = dispatch.call(this, event);
      if (!traffic.counting || !(this instanceof WebSocket) || !(event instanceof MessageEvent) ||
          typeof event.data !== "string") return result;
      if (event.data.startsWith('{"type":"enhanced_presence"')) {
        traffic.reports += 1;
        traffic.last = Number(event.data.match(/"activity":"Step (\d+)"/u)?.[1] ?? -1);
      } else if (event.data.startsWith('{"type":"channel_updated"')) traffic.snapshots += 1;
      return result;
    };
  });
  const send = await openWorkingAgentsSpace(page, space, messages, "Row 40:");
  await conversationOpened(page);
  await page.waitForLoadState("networkidle");
  await delay(2_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map(metric => [metric.name, metric.value]),
  );
  await page.evaluate(() => {
    (window as unknown as { __loadTraffic: Traffic }).__loadTraffic.counting = true;
    (window as unknown as { __renderCounts: { counting: boolean } }).__renderCounts.counting = true;
  });
  const before = await metrics();
  let windowBefore = before;
  const startedAt = Date.now();
  let sent = 0;
  const windows: number[] = [];
  for (let tick = 0; tick < SECONDS * 10; tick += 1) {
    for (let burst = 0; burst < REPORTS_PER_SECOND / 10; burst += 1) {
      const index = sent % 10 === 0 ? 0 : 1 + (sent % (AGENTS - 1));
      for (const frame of space.report(index, `Step ${sent}`)) send(frame);
      sent += 1;
    }
    // Node's deadline avoids browser-side timers/actions becoming the load.
    await delay(Math.max(0, startedAt + (tick + 1) * 100 - Date.now()));
    if ((tick + 1) % 100 === 0) {
      const current = await metrics();
      windows.push((current.TaskDuration - windowBefore.TaskDuration) / (current.Timestamp - windowBefore.Timestamp));
      windowBefore = current;
    }
  }
  // The final burst has a full 100ms to arrive and flush before this read.
  const after = await metrics();
  const elapsed = after.Timestamp - before.Timestamp;
  const traffic = await page.evaluate(() => (window as unknown as { __loadTraffic: Traffic }).__loadTraffic);
  const renders = await page.evaluate(() =>
    (window as unknown as { __renderCounts: { workspaceViews: number; messageRows: number } }).__renderCounts);
  const busy = (after.TaskDuration - before.TaskDuration) / elapsed;
  console.log(`[thousand-agents] ${sent} reports in ${elapsed.toFixed(1)}s: ${JSON.stringify({
    mainThreadBusy: Number(busy.toFixed(3)),
    windows: windows.map(value => Number(value.toFixed(3))),
    script: Number((after.ScriptDuration - before.ScriptDuration).toFixed(2)),
    style: Number((after.RecalcStyleDuration - before.RecalcStyleDuration).toFixed(2)),
    layout: Number((after.LayoutDuration - before.LayoutDuration).toFixed(2)),
    received: traffic,
    connections: send.connections(),
  })}`);
  console.log(`[thousand-agent-renders] ${JSON.stringify(renders)}`);
  expect(traffic.reports).toBe(REPORTS_PER_SECOND * SECONDS);
  expect(traffic.snapshots).toBe(traffic.reports);
  expect(traffic.last).toBe(sent - 1);
  expect(send.connections()).toBe(1);
  expect(elapsed).toBeGreaterThanOrEqual(SECONDS);
  expect(elapsed).toBeLessThan(SECONDS + 1);
  // The separate render-scope test isolates report-driven shell commits. This
  // minute also includes ordinary expiry/clock housekeeping.
  expect(renders.messageRows).toBe(0);
  expect(busy).toBeLessThan(0.1);
  for (const windowBusy of windows) expect(windowBusy).toBeLessThan(0.1);
});
