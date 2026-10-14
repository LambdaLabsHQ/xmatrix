import { setTimeout as delay } from "node:timers/promises";
import { fixtureRequestRecords } from "./in-page-api-fixtures";
import { readNativeHumanSocketTraffic, routeNativeHumanSocket, type NativeHumanSocketTraffic } from "./native-human-socket-fixture";
import { installRenderCounter } from "./render-counts";
import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, conversationOpened } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

const CHANNELS = 1000;
const FOCUSED_INSTANCES = 10;
const SECONDS = 60;
const TICK_MS = 100;
/** One message into another conversation every tick, one into the open one every fifth. */
const OPEN_EVERY = 5;
const HISTORY = 40;
const CATALOG_WINDOW_MS = 500;

test.use({ ...E2E_DESKTOP_CONTEXT, trace: "off" });

type Arrivals = { counting: boolean; total: number; open: number; byChannel: Record<string, number> };
type RenderCounts = { navRows: number; messageRows: number; workspaceViews: number; commits: number; counting: boolean };

/**
 * A minute of Agents posting into a thousand conversations: ten messages a
 * second walk every other Channel in turn, two a second land in the open one,
 * over the product's own socket, with its normal animations.
 *
 * What is asserted is the work a message may cost, which does not depend on
 * the machine: every frame arrives on one connection and is consumed, the
 * open conversation renders each new row once, the list is never read again
 * for a message, Channels nobody here knows are asked for once per catalog
 * window, and the shell and the list rows render per window and per arrival,
 * not per message times the size of the list.
 *
 * The share of the main thread is reported for each ten-second window. It is
 * above the ten percent the presence gate holds (thousand-agent-performance):
 * a message that changes what is on screen costs frames a status report does
 * not. Its ceiling here only keeps what was gained; the budget is not met.
 */
test("a minute of messages into a thousand conversations costs each of them once", async ({ page }) => {
  test.setTimeout(180_000);
  // Ten working Instances share the open conversation; every other Agent has its own.
  const base = workingAgentsSpace(CHANNELS + FOCUSED_INSTANCES - 1, "k",
    { focusedInstances: FOCUSED_INSTANCES, intent: "Review channels and message performance" });
  // The reader starts caught up everywhere, so an unread count is the messages of this minute.
  const space = { ...base, channels: base.channels.map((channel) => ({ ...channel, readSequence: HISTORY })) };
  expect(new Set(space.channels.map((channel) => channel.id)).size).toBe(CHANNELS);
  const history = channelHistory(HISTORY, "k-message", (row) => `Row ${row}: a **status** update with \`code\` and a list:\n\n- one\n- two`);

  await installRenderCounter(page);
  await page.addInitScript((openChannelId) => {
    const arrivals: Arrivals = { counting: false, total: 0, open: 0, byChannel: {} };
    (window as unknown as { __messageArrivals: Arrivals }).__messageArrivals = arrivals;
    // The product says so itself once a message is merged into its history and summary.
    window.addEventListener("xmatrix:channel-catalog-change", (event) => {
      const detail = (event as CustomEvent<{ kind?: string; channelId?: string }>).detail;
      if (!arrivals.counting || detail?.kind !== "message" || !detail.channelId) return;
      arrivals.total += 1;
      if (detail.channelId === openChannelId) arrivals.open += 1;
      else arrivals.byChannel[detail.channelId] = (arrivals.byChannel[detail.channelId] ?? 0) + 1;
    });
  }, E2E_CHANNEL.id);

  const send = await openWorkingAgentsSpace(page, space, history, `Row ${HISTORY}:`, { routeSocket: routeNativeHumanSocket });
  await conversationOpened(page);
  await expect(page.locator(".app-agent-work-intent:not(.app-agent-work-intent-stale)")).toHaveCount(FOCUSED_INSTANCES);
  await page.waitForLoadState("networkidle");
  await delay(2_000);

  // Every message: its own id, the next sequence of its Channel, an Agent of that Channel as sender.
  const others = Array.from({ length: CHANNELS - 1 }, (_, slot) => FOCUSED_INSTANCES + slot);
  const sequences = new Map<string, number>();
  const sentTo = new Map<string, { body: string; count: number }>();
  let ordinal = 0;
  const message = (agentIndex: number, label: string) => {
    const agent = space.agents[agentIndex]!;
    const channelId = space.channelId(agentIndex);
    const sequence = (sequences.get(channelId) ?? HISTORY) + 1;
    sequences.set(channelId, sequence);
    ordinal += 1;
    const body = `${label} ${sequence}: finished **step ${ordinal}** with \`code\`.`;
    sentTo.set(channelId, { body, count: (sentTo.get(channelId)?.count ?? 0) + 1 });
    return { type: "channel_message_received", message: {
      messageId: `arrival-${ordinal}`, channelId, sequence, body, sentAt: new Date().toISOString(),
      reactions: [], annotations: [], attachments: [],
      from: { kind: "agent", label: agent.name, userId: "e2e-user", email: agent.email, identityId: agent.id,
        instanceId: agent.instances[0]!.id, channelInstanceId: "1", instanceLabel: agent.instances[0]!.label },
    } };
  };

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]),
  );
  const catalogBefore = (await fixtureRequestRecords(page, "channel-catalog")).length;
  await page.evaluate(() => {
    (window as unknown as { __nativeHumanSocketTraffic: NativeHumanSocketTraffic }).__nativeHumanSocketTraffic.counting = true;
    (window as unknown as { __messageArrivals: Arrivals }).__messageArrivals.counting = true;
    (window as unknown as { __renderCounts: RenderCounts }).__renderCounts.counting = true;
  });
  const before = await metrics();
  let windowBefore = before;
  const startedAt = Date.now();
  const windows: number[] = [];
  let latest = 0;
  let toOthers = 0;
  let toOpen = 0;
  for (let tick = 0; tick < (SECONDS * 1000) / TICK_MS; tick += 1) {
    send(message(others[toOthers % others.length]!, "Progress"));
    toOthers += 1;
    if (tick % OPEN_EVERY === 0) {
      send(message(toOpen % FOCUSED_INSTANCES, "Open"));
      toOpen += 1;
    }
    // Node keeps the pace: no timer or action in the page becomes part of the load.
    const due = startedAt + (tick + 1) * TICK_MS;
    latest = Math.max(latest, Date.now() - due);
    await delay(Math.max(0, due - Date.now()));
    if ((tick + 1) % (10_000 / TICK_MS) === 0) {
      const current = await metrics();
      windows.push((current.TaskDuration - windowBefore.TaskDuration) / (current.Timestamp - windowBefore.Timestamp));
      windowBefore = current;
    }
  }
  // The last message has had its normal interval before this read; nothing is drained.
  const after = await metrics();
  const elapsed = after.Timestamp - before.Timestamp;
  const traffic = await readNativeHumanSocketTraffic(page);
  const { arrivals, renders } = await page.evaluate(() => {
    const state = window as unknown as { __messageArrivals: Arrivals; __renderCounts: RenderCounts };
    // Frozen here: the checks of the final screen below scroll and remount rows.
    state.__messageArrivals.counting = false;
    state.__renderCounts.counting = false;
    return { arrivals: { ...state.__messageArrivals, byChannel: { ...state.__messageArrivals.byChannel } }, renders: { ...state.__renderCounts } };
  });
  const catalogAsked = (await fixtureRequestRecords(page, "channel-catalog")).slice(catalogBefore);
  const listReads = catalogAsked.filter((request) => /\/channels\/page(\?|$)/u.test(request.url)).length;
  const resolves = catalogAsked.filter((request) => /\/channels\/resolve(\?|$)/u.test(request.url)).length;
  const busy = (after.TaskDuration - before.TaskDuration) / elapsed;
  console.log(`[message-arrival] ${toOthers} + ${toOpen} messages in ${elapsed.toFixed(1)}s: ${JSON.stringify({
    mainThreadBusy: Number(busy.toFixed(3)),
    windows: windows.map((value) => Number(value.toFixed(3))),
    script: Number((after.ScriptDuration - before.ScriptDuration).toFixed(2)),
    style: Number((after.RecalcStyleDuration - before.RecalcStyleDuration).toFixed(2)),
    layout: Number((after.LayoutDuration - before.LayoutDuration).toFixed(2)),
    styleUpdates: after.RecalcStyleCount - before.RecalcStyleCount,
    received: traffic.byType.channel_message_received ?? 0,
    consumed: { others: arrivals.total - arrivals.open, open: arrivals.open },
    renders, listReads, resolves, latestTickMs: latest, connections: send.connections(),
  })}`);

  // Sent, received and consumed: one connection, every frame, each Channel its own messages.
  expect(toOthers).toBe((SECONDS * 1000) / TICK_MS);
  expect(toOpen).toBe(toOthers / OPEN_EVERY);
  expect(send.connections()).toBe(1);
  expect(traffic.connections).toBe(1);
  expect(traffic.byType.channel_message_received).toBe(toOthers + toOpen);
  expect(arrivals.open).toBe(toOpen);
  expect(arrivals.total - arrivals.open).toBe(toOthers);
  for (const [channelId, sent] of sentTo) {
    if (channelId !== E2E_CHANNEL.id) expect(arrivals.byChannel[channelId], channelId).toBe(sent.count);
  }
  expect(elapsed).toBeGreaterThanOrEqual(SECONDS);
  expect(elapsed).toBeLessThan(SECONDS + 1);

  // The open conversation rendered each new row. Following its tail mounts a
  // row or two at the other edge of the list; the rows on screen are not
  // rendered again for a message.
  expect(renders.messageRows).toBeGreaterThanOrEqual(toOpen);
  expect(renders.messageRows).toBeLessThanOrEqual(4 * toOpen);
  // A message never reads the list again; Channels nobody knew are asked for once a window.
  expect(listReads).toBe(0);
  expect(resolves).toBeLessThanOrEqual((SECONDS * 1000) / CATALOG_WINDOW_MS + 5);
  // The shell renders with the catalog window and the open conversation's
  // messages, a row with its own messages and when it enters the list: none of
  // them once per message for every row there is.
  expect(renders.workspaceViews).toBeLessThanOrEqual(6 * ((SECONDS * 1000) / CATALOG_WINDOW_MS) + 6 * toOpen);
  expect(renders.navRows).toBeLessThanOrEqual(3 * toOthers + 6 * toOpen);

  // The final screen says what arrived. The open conversation is at its last message.
  const lastOpen = sentTo.get(E2E_CHANNEL.id)!;
  expect(sequences.get(E2E_CHANNEL.id)).toBe(HISTORY + toOpen);
  await expect(page.locator(".app-message-timeline").getByText(lastOpen.body.replace(/[*`]/gu, ""), { exact: false })).toBeVisible();
  // Another conversation shows its message and counts it unread, wherever it stands in the list.
  const list = page.locator(".app-sidebar .app-sidebar-pane-body");
  const shows = async (slot: number) => {
    const channelId = space.channelId(others[slot % others.length]!);
    const sent = sentTo.get(channelId)!;
    const row = page.locator(`.app-sidebar [data-channel-row-id="${channelId}"]`);
    await expect(row).toContainText(sent.body.replace(/[*`]/gu, "").slice(0, 24));
    await expect(row.locator(".app-count-pill-value")).toHaveText(String(sent.count));
  };
  // The last one is the newest: the first row of the list once its window has closed.
  await shows(toOthers - 1);
  // The list is virtualized. An earlier one is further down, in the order they arrived.
  for (const slot of [Math.floor(toOthers / 2), 0]) {
    const row = page.locator(`.app-sidebar [data-channel-row-id="${space.channelId(others[slot % others.length]!)}"]`);
    await expect.poll(async () => {
      if (await row.count()) return true;
      await list.evaluate((element) => { element.scrollTop += element.clientHeight * 0.8; });
      return false;
    }, { timeout: 60_000, intervals: [60] }).toBe(true);
    await shows(slot);
  }

  // What was gained is kept; the ten percent of the presence gate is not reached yet.
  expect(busy).toBeLessThan(0.6);
  for (const windowBusy of windows) expect(windowBusy).toBeLessThan(0.6);
});
