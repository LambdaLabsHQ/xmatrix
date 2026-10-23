import { installRenderCounter } from "./render-counts";
import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, conversationOpened, fixtureJson, fixtureRequests } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const CHANNEL_COUNT = 40;
const space = workingAgentsSpace(CHANNEL_COUNT, "load");
const messages = channelHistory(40, "load-message", (row) => `Load row ${row}: a **status** update with \`code\`.`);

/**
 * Dozens of Agents working at once stream presence and activity for every
 * conversation. Each report must re-render what it concerns - its own
 * conversation's row - and leave the open conversation's messages alone.
 * Rendering the whole list and every visible message (Markdown included) per
 * report is what made a busy Space stutter in the desktop app. React commits
 * are counted through the DevTools hook, so host speed cannot move the result.
 */
for (const delivery of ["cards", "digest"] as const) test(`Agents in other conversations re-render only their own rows (${delivery})`, async ({ page }) => {
  await installRenderCounter(page);
  const send = await openWorkingAgentsSpace(page, space, messages, "Load row 40:");
  // The last conversation is below the fold: the list only mounts rows near the viewport.
  await expect(page.locator(`[data-channel-row-id="${space.channelId(1)}"]`)).toBeVisible();
  await conversationOpened(page);

  await page.evaluate(() => {
    (window as unknown as { __renderCounts: { counting: boolean } }).__renderCounts.counting = true;
  });
  const reports = CHANNEL_COUNT - 1;
  const digest: unknown[] = [];
  for (let index = 1; index <= reports; index += 1) {
    const activity = `Running step ${index}`;
    // Exercise both current cards and compatible whole-Channel snapshots.
    const frames = space.report(index, activity);
    if (delivery === "digest") digest.push(frames[0].agent);
    else {
      for (const frame of frames) send(frame);
      // Independent reports stay separate; a digest exercises one multi-Instance flush.
      await page.waitForTimeout(20);
    }
  }
  if (delivery === "digest") send({ type: "presence_digest", agents: digest });
  // Frames are applied as they arrive; give the last ones a moment to commit.
  await page.waitForTimeout(500);
  const counts = await page.evaluate(() =>
    (window as unknown as { __renderCounts: { navRows: number; messageRows: number; workspaceViews: number; commits: number } }).__renderCounts);
  console.log(`[live-agent-load] ${reports} reports: ${JSON.stringify(counts)}`);

  expect(counts.commits).toBeGreaterThan(0);
  // The open conversation is none of theirs: its messages never re-render.
  expect(counts.messageRows).toBe(0);
  expect(counts.workspaceViews).toBe(0);
  // Each report touches its own row; the other 39 stay as they were.
  expect(counts.navRows).toBeGreaterThan(0);
  expect(counts.navRows).toBeLessThanOrEqual(reports * 2);
});

test("current-Channel activity leaves Markdown and the work dock alone and opens the latest owned trace", async ({ page }) => {
  const current = workingAgentsSpace(1, "current", { intent: "Verify current work" });
  const agent = current.agents[0];
  const messages = channelHistory(40, "current-message", row => `Current row ${row}: **unchanged**.`)
    .map(message => ({ ...message, sentAt: new Date(Date.parse(message.sentAt) + message.sequence * 600_000).toISOString(),
      from: { kind: "agent", identityId: agent.id, userId: agent.userId,
      label: "agent0:1", instanceId: agent.instances[0].id, channelInstanceId: "1", instanceLabel: "agent0:1",
      email: agent.email } }));
  await installRenderCounter(page);
  // Current Hubs discover cards through presence, not an agent_list roster.
  const send = await openWorkingAgentsSpace(page, { ...current, agents: [] }, messages, "Current row 40:");
  await fixtureJson(page, "current-trace", `**/api/xmatrix/trace/instances/${agent.instances[0].id}/events?**`,
    { availability: "available", complete: true, events: [], cursor: null, nextCursor: null });
  await conversationOpened(page);
  // Establish the authoritative snapshot after the opening/read acknowledgement.
  for (const frame of current.report(0, "Working")) send(frame);
  await expect(page.locator(".app-agent-work-dock").getByRole("button", { name: /Open agent0/ })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    (window as unknown as { __renderCounts: { counting: boolean } }).__renderCounts.counting = true;
  });
  for (let step = 1; step <= 30; step += 1) {
    for (const frame of current.report(0, `Current step ${step}`)) send(frame);
    await page.waitForTimeout(20);
  }
  const dock = page.locator(".app-agent-work-dock");
  await expect(dock.getByRole("button", { name: /Open agent0/ })).toBeVisible();
  await page.waitForTimeout(50);
  const counts = await page.evaluate(() =>
    (window as unknown as { __renderCounts: { messageRows: number; workspaceViews: number; workDocks: number; workAvatars: number } }).__renderCounts);
  expect(counts.messageRows).toBe(0);
  expect(counts.workspaceViews).toBe(0);
  expect(counts.workDocks).toBe(0);
  expect(counts.workAvatars).toBe(0);
  // The island skips activity-only commits, but a real click resolves the
  // current complete Instance instead of the item last used to paint it.
  await dock.getByRole("button", { name: /Open agent0/ }).click();
  await expect(page.getByRole("dialog").getByText("Current step 30", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator('[id="message:current-message-40"] .identity-avatar').click();
  await expect(page.getByRole("dialog").getByText("Current step 30", { exact: true })).toBeVisible();
  await expect.poll(async () => (await fixtureRequests(page, "current-trace")).length).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A changed task must still repaint the island. This positive control also
  // proves that the counters above observe the components being protected.
  const taskChannel = current.report(0, "Current step 30")[1].channel!;
  const member = taskChannel.memberPresence[agent.id];
  send({ type: "channel_updated", channel: { ...taskChannel, memberPresence: {
    ...taskChannel.memberPresence, [agent.id]: { ...member, instances: member.instances.map((instance: typeof agent.instances[number]) =>
      ({ ...instance, intent: "Verify next task" })) },
  } } });
  await expect(dock.locator(".app-agent-work-intent").first()).toContainText("Verify next task");
  const taskCounts = await page.evaluate(() =>
    (window as unknown as { __renderCounts: { workDocks: number; workAvatars: number } }).__renderCounts);
  expect(taskCounts.workDocks).toBeGreaterThan(0);
  expect(taskCounts.workAvatars).toBeGreaterThan(0);
  // Ignoring Agent activity in the header must still follow live Human counts.
  const liveChannel = current.report(0, "Current step 30")[1].channel!;
  const header = page.locator(".app-main .app-panel-header").first();
  for (const [status, label] of [["online", "1/1"], ["offline", "0/1"]] as const) {
    send({ type: "channel_updated", channel: { ...liveChannel, memberPresence: {
      ...liveChannel.memberPresence,
      "user:e2e-user": { kind: "user", label: "E2E Tester", status },
    } } });
    await expect(header.getByTitle("Channel details", { exact: true })).toHaveText(label);
  }
  send({ type: "channel_updated", channel: { ...current.channels[0], memberPresence: {} } });
  send({ type: "agent_lifecycle", channelId: current.channelId(0), agentId: agent.id,
    instanceId: agent.instances[0].id, status: "offline", layer: "agent", ts: new Date().toISOString() });
  await expect(page.locator('[id="message:current-message-40"]').getByText("instance offline", { exact: true })).toBeVisible();
  // Presence-discovered cards remain searchable while the shell uses its
  // stable catalog snapshot and the Hub sends an empty agent_list.
  await page.keyboard.press("Control+f");
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await search.getByRole("textbox").fill("from:agent0");
  await expect(search.getByRole("button", { name: /agent0.*Agent/ })).toBeVisible();
});
