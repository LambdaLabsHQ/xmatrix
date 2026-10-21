import { setTimeout as delay } from "node:timers/promises";
import { readNativeHumanSocketTraffic, routeNativeHumanSocket, type NativeHumanSocketTraffic } from "./native-human-socket-fixture";
import { installRenderCounter } from "./render-counts";
import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, conversationOpened, fixtureJson } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

const FOCUSED_INSTANCES = 10;
const CHANNELS = 1900;
const AGENTS = CHANNELS + FOCUSED_INSTANCES - 1;
const REPORTS_PER_SECOND = 100;
const nativeSocket = process.env.XMATRIX_PERF_TRANSPORT !== "cdp";

test.use({ ...E2E_DESKTOP_CONTEXT, trace: "off", humanSocketWorker: nativeSocket });
const messages = channelHistory(40, "k-message", (row) => `Row ${row}: a **status** update with \`code\` and a list:\n\n- one\n- two`);

type Traffic = { counting: boolean; reports: number; snapshots: number; last: number };

/** Absolute renderer TaskDuration, including normal animations and delivery.
 * Every report retains the legacy Hub pair (Agent card + whole Channel), at
 * 100 reports/s for one minute, in ten bursts per second. Ten percent of reports target the open
 * Channel, the rest exercise the thousand-Channel catalog. Each ten-second
 * window must meet the same budget: neither idle subtraction nor a long drain
 * can disguise sustained work or socket loss. Playwright DOM snapshots are
 * excluded because they walk the whole page on every test action. Native TCP
 * WebSocket delivery measures the product path; XMATRIX_PERF_TRANSPORT=cdp keeps
 * the old injected transport available for diagnostic comparisons. CDP still
 * accounts for all product script, style, layout and native renderer work.
 */
const ticksPerSecond = 10;
const SECONDS = 60;
test(`${AGENTS} Agents across ${CHANNELS} Channels stay below ten percent with burst reports for ${SECONDS}s`, async ({ page }) => {
  test.setTimeout((SECONDS + 90) * 1_000);
  const space = workingAgentsSpace(AGENTS, "k", { focusedInstances: FOCUSED_INSTANCES, intent: "Review channels and message performance" });
  await installRenderCounter(page);
  if (!nativeSocket) await page.addInitScript(() => {
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
  const send = await openWorkingAgentsSpace(page, space, messages, "Row 40:",
    { routeSocket: nativeSocket ? routeNativeHumanSocket : undefined, initialAgentList: [] });
  await conversationOpened(page);
  await expect(page.locator(".app-agent-work-intent:not(.app-agent-work-intent-stale)")).toHaveCount(FOCUSED_INSTANCES);
  await page.waitForLoadState("networkidle");
  await delay(2_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map(metric => [metric.name, metric.value]),
  );
  await page.evaluate(native => {
    if (native) (window as unknown as { __nativeHumanSocketTraffic: NativeHumanSocketTraffic }).__nativeHumanSocketTraffic.counting = true;
    else (window as unknown as { __loadTraffic: Traffic }).__loadTraffic.counting = true;
    (window as unknown as { __renderCounts: { counting: boolean } }).__renderCounts.counting = true;
  }, nativeSocket);
  const before = await metrics();
  let windowBefore = before;
  const startedAt = Date.now();
  let sent = 0;
  let otherReports = 0;
  const windows: number[] = [];
  for (let tick = 0; tick < SECONDS * ticksPerSecond; tick += 1) {
    for (let burst = 0; burst < REPORTS_PER_SECOND / ticksPerSecond; burst += 1) {
      const index = sent % 10 === 0 ? (sent / 10) % FOCUSED_INSTANCES :
        FOCUSED_INSTANCES + (otherReports++ % (AGENTS - FOCUSED_INSTANCES));
      for (const frame of space.report(index, `Step ${sent}`)) send(frame);
      sent += 1;
    }
    // A normal immediate control frame closes the final transport packet
    // before the unchanged deadline. No receipt/drain wait extends the CPU
    // window, and the control's processing is measured with the reports.
    if (sent === REPORTS_PER_SECOND * SECONDS) send({ type: "pong", requestId: "performance-complete" });
    // Node's deadline avoids browser-side timers/actions becoming the load.
    await delay(Math.max(0, startedAt + (tick + 1) * (1000 / ticksPerSecond) - Date.now()));
    if ((tick + 1) % (10 * ticksPerSecond) === 0 && tick + 1 < SECONDS * ticksPerSecond) {
      const current = await metrics();
      windows.push((current.TaskDuration - windowBefore.TaskDuration) / (current.Timestamp - windowBefore.Timestamp));
      windowBefore = current;
    }
  }
  // The final report has the normal inter-arrival interval before this read.
  const nativeTraffic = nativeSocket ? await readNativeHumanSocketTraffic(page) : null;
  const traffic: Traffic = nativeTraffic ? { counting: nativeTraffic.counting, reports: nativeTraffic.byType.enhanced_presence ?? 0,
    snapshots: nativeTraffic.byType.channel_updated ?? 0, last: nativeTraffic.lastStep } :
    await page.evaluate(() => (window as unknown as { __loadTraffic: Traffic }).__loadTraffic);
  // Witness receipts before the CPU cutoff. This is one snapshot, never a
  // drain/poll, and its own main-thread cost remains in the final window.
  const after = await metrics();
  const elapsed = after.Timestamp - before.Timestamp;
  windows.push((after.TaskDuration - windowBefore.TaskDuration) / (after.Timestamp - windowBefore.Timestamp));
  const renders = await page.evaluate(() =>
    (window as unknown as { __renderCounts: { workspaceViews: number; messageRows: number } }).__renderCounts);
  const busy = (after.TaskDuration - before.TaskDuration) / elapsed;
  console.log(`[thousand-agents] ${sent} reports in ${elapsed.toFixed(1)}s: ${JSON.stringify({
    transport: nativeSocket ? "native-websocket" : "cdp-injected",
    agents: AGENTS,
    channels: space.channels.length,
    reportsPerTick: REPORTS_PER_SECOND / ticksPerSecond,
    mainThreadBusy: Number(busy.toFixed(3)),
    windows: windows.map(value => Number(value.toFixed(3))),
    script: Number((after.ScriptDuration - before.ScriptDuration).toFixed(2)),
    style: Number((after.RecalcStyleDuration - before.RecalcStyleDuration).toFixed(2)),
    layout: Number((after.LayoutDuration - before.LayoutDuration).toFixed(2)),
    styleUpdates: after.RecalcStyleCount - before.RecalcStyleCount,
    received: traffic,
    connections: send.connections(),
    workerConnections: nativeTraffic?.workerConnections,
    workerPackets: nativeTraffic?.workerPackets,
  })}`);
  console.log(`[thousand-agent-renders] ${JSON.stringify(renders)}`);
  await expect(page.locator(".app-agent-work-intent:not(.app-agent-work-intent-stale)")).toHaveCount(FOCUSED_INSTANCES);
  expect(traffic.reports).toBe(REPORTS_PER_SECOND * SECONDS);
  expect(traffic.snapshots).toBe(traffic.reports);
  expect(traffic.last).toBe(sent - 1);
  expect(send.connections()).toBe(1);
  if (nativeTraffic) {
    expect(nativeTraffic.connections).toBe(1);
    expect(nativeTraffic.workerConnects).toBe(1);
    expect(nativeTraffic.workerConnections).toBe(1);
    expect(nativeTraffic.workerPackets).toBeGreaterThan(0);
    expect(nativeTraffic.workerPackets).toBeLessThan(traffic.reports);
  }
  expect(elapsed).toBeGreaterThanOrEqual(SECONDS);
  expect(elapsed).toBeLessThan(SECONDS + 1);
  // The separate render-scope test isolates report-driven shell commits. This
  // run also includes ordinary expiry/clock housekeeping.
  expect(renders.messageRows).toBe(0);
  // Arrival counters alone cannot prove the app consumed its final live state.
  // Exercise the real trace UI only after every measured value is captured.
  await fixtureJson(page, "load-final-trace", "**/api/xmatrix/trace/instances/instance-k-9/events?**",
    { availability: "available", complete: true, events: [], cursor: null, nextCursor: null });
  await page.locator(".app-agent-work-dock").getByRole("button", { name: /^Open agent9 -/u }).click();
  await expect(page.getByRole("dialog").getByText(`Step ${sent - 10}`, { exact: true })).toBeVisible();
  expect(busy).toBeLessThan(0.1);
  for (const windowBusy of windows) expect(windowBusy).toBeLessThan(0.1);
});
