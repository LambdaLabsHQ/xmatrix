import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, E2E_USER_SENDER,
  fixtureJson, fixtureRequests, fixtureRequestBodies, installWorkspaceStubs, routeHumanSocket,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

for (const { memberId, retainedAlias } of [
  { memberId: "instance-claude", retainedAlias: false },
  { memberId: "agent:legacy-claude", retainedAlias: false },
  { memberId: "instance-claude", retainedAlias: true },
]) {
  test(`one Claude stays one avatar through launch and message delivery under ${memberId} (retained alias: ${retainedAlias})`, async ({ page }) => {
    const instance = { id: "instance-claude", channelId: E2E_CHANNEL.id, channelInstanceId: "1",
      label: "Claude:1", connectedAt: E2E_NOW, lastSeenAt: E2E_NOW, status: "idle" };
    const avatarUrl = "/agent-vendors/claude.svg";
    const presence = { registration: { ownerUserId: "owner-1", machineId: "machine-1", harness: "claude" }, kind: "agent", label: "Claude", avatarUrl, instances: [instance] };
    const channel = { ...E2E_CHANNEL, messageCount: 1, historyHeadSequence: 1,
      memberPresence: { [memberId]: presence,
        ...(retainedAlias ? { "agent:instance-claude": { ...presence, avatarUrl: undefined } } : {}) } };
    const history = [{ messageId: "summon-claude", channelId: channel.id, sequence: 1,
      sentAt: E2E_NOW, from: E2E_USER_SENDER, body: "@claude check this" }];
    let send: ((frame: unknown) => void) | undefined;
    await routeHumanSocket(page, (frame, reply) => {
      if (frame.type === "human_connect") send = reply;
      if (frame.type === "ping") reply({ type: "pong", requestId: frame.requestId });
      if (frame.type === "user_focus_channel") reply({ type: "channel_history",
        requestId: frame.requestId, channelId: channel.id, messages: history, hasMore: false });
    });
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
    await fixtureJson(page, "identity-history", "**/api/xmatrix/channels/channel-general/history**",
      { messages: history, hasMore: false });
    // The launch read can lag the connected Instance. It must not add a second card.
    await fixtureJson(page, "identity-launch", "**/api/xmatrix/channels/channel-general/agent-launches/query", {
      launches: [{ launchId: "launch-claude", channelId: channel.id, sourceMessageId: "summon-claude",
        targetName: "Claude", instanceId: instance.id, runId: "run-claude", state: "spawned",
        createdAt: E2E_NOW, updatedAt: E2E_NOW, attempt: 0, retryable: false }],
      rejections: [], continuations: [], executions: [], nextCursor: null,
    });
    await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
    const avatars = page.locator(".app-agent-work-avatar");
    await expect(avatars).toHaveCount(1);
    await expect(avatars.locator("img")).toHaveAttribute("src", avatarUrl);
    await expect.poll(() => Boolean(send)).toBe(true);
    const incoming = { messageId: "claude-reply", channelId: channel.id, sequence: 2,
      sentAt: "2026-07-01T00:01:00.000Z", body: "Claude has finished checking.",
      from: { kind: "agent", identityId: `agent:${instance.id}`, agentName: "Claude",
        instanceId: instance.id, channelInstanceId: "1", instanceLabel: "Claude:1",
        label: "Claude:1", userId: "agent-owner", email: "" } };
    send!({ type: "channel_message_received", message: incoming });
    await expect(page.locator(".app-message-timeline").getByText(incoming.body, { exact: true })).toBeVisible();
    await expect(avatars).toHaveCount(1);
    await expect(avatars.locator("img")).toHaveAttribute("src", avatarUrl);

    // A second Instance of the same harness is still a second card.
    const second = { ...instance, id: "instance-claude-2", channelInstanceId: "2", label: "Claude:2" };
    send!({ type: "channel_updated", channel: { ...channel, memberPresence: {
      [memberId]: presence, [second.id]: { ...presence, instances: [second] },
    } } });
    await expect(avatars).toHaveCount(2);
    await expect(avatars.locator("img")).toHaveCount(2);
  });
}

/** #general holding no Instance yet, open, and the Human socket's send once it is connected. */
async function openChannelWithoutInstances(page: Page) {
  const initial = { ...E2E_CHANNEL, memberPresence: {} };
  let reply: ((frame: unknown) => void) | undefined;
  await routeHumanSocket(page, (frame, answer) => {
    if (frame.type === "human_connect") reply = answer;
    if (frame.type === "ping") answer({ type: "pong", requestId: frame.requestId });
    if (frame.type === "user_focus_channel") answer({ type: "channel_history",
      requestId: frame.requestId, channelId: initial.id, messages: [], hasMore: false });
  });
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [initial] });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect.poll(() => Boolean(reply)).toBe(true);
  return { initial, send: (frame: unknown) => reply!(frame) };
}

test("two successive unknown Instance reports both obtain authoritative cards", async ({ page }) => {
  const { fixtureChannelCatalog } = await import("./workspace-fixtures");
  const { initial, send } = await openChannelWithoutInstances(page);
  const members: Record<string, unknown> = {};
  for (const slot of [1, 2]) {
    const instance = { id: `rapid-${slot}`, channelId: initial.id, channelInstanceId: String(slot),
      label: `Claude:${slot}`, connectedAt: E2E_NOW, lastSeenAt: E2E_NOW, status: "idle" };
    const report = { type: "enhanced_presence", agent: { id: instance.id, instanceId: instance.id, name: "Claude",
      userId: "owner", type: "claude", lifetime: "short", email: "", metadata: {},
      status: "idle", connectedAt: E2E_NOW, lastSeenAt: E2E_NOW, instances: [instance] } };
    if (slot === 1) {
      // The first catalog read races ahead of the new Instance's commit.
      await fixtureChannelCatalog(page, "rapid-before-commit", [initial]);
      send(report);
      await expect.poll(async () => (await fixtureRequests(page, "rapid-before-commit")).length).toBeGreaterThan(0);
      await page.clock.setFixedTime(Date.now() + 1_001);
    }
    members[instance.id] = { kind: "agent", label: "Claude", instances: [instance],
      registration: { ownerUserId: "owner", machineId: "machine", harness: "claude" } };
    await fixtureChannelCatalog(page, `rapid-authority-${slot}`, [{ ...initial, memberPresence: { ...members } }]);
    send(report);
    await expect(page.locator(".app-agent-work-avatar")).toHaveCount(slot);
  }
  await expect(page.locator(".app-agent-work-avatar img")).toHaveCount(2);
});

/* An Instance joining a Channel is reported twice, together: the Hub sends the
   Agent's card and then the Channel that now holds it. The card used to be
   placed first, into a Channel without the Instance, which counted as a
   conflict and read the Channel again on every join. A catalog read that
   races the join can still lack the Instance, and the work dock went and came
   back: the whole timeline moved by its height and back. */
test("an Instance that joins with its card and its Channel together is placed without reading the Channel again", async ({ page }) => {
  const { fixtureChannelCatalog } = await import("./workspace-fixtures");
  const warnings: string[] = [];
  page.on("console", (message) => { if (message.text().includes("[presence]")) warnings.push(message.text()); });
  const { initial, send } = await openChannelWithoutInstances(page);
  // A read now would be the one that races the join: it still has no Instance.
  await fixtureChannelCatalog(page, "join-reread", [initial]);
  const instance = { id: "joining-1", channelId: initial.id, channelInstanceId: "1",
    label: "Claude:1", connectedAt: E2E_NOW, lastSeenAt: E2E_NOW, status: "busy", activity: "Reading" };
  send({ type: "enhanced_presence", agent: { id: instance.id, instanceId: instance.id, name: "Claude",
    userId: "owner", type: "claude", lifetime: "short", email: "", metadata: {},
    status: "busy", connectedAt: E2E_NOW, lastSeenAt: E2E_NOW, instances: [instance] } });
  send({ type: "channel_updated", channel: { ...initial, memberPresence: { [instance.id]: { kind: "agent",
    label: "Claude", instances: [instance], registration: { ownerUserId: "owner", machineId: "machine", harness: "claude" } } } } });
  await expect(page.locator(".app-agent-work-avatar")).toHaveCount(1);
  // Past the batch and a catalog read's round trip: the dock stays and nothing was read again.
  await page.waitForTimeout(600);
  await expect(page.locator(".app-agent-work-avatar")).toHaveCount(1);
  expect(await fixtureRequests(page, "join-reread")).toEqual([]);
  expect(warnings).toEqual([]);
});

test("versioned Instance reports alone drive dock, sender badge and Reborn through late windows and lifecycle replay", async ({ page }) => {
  const { installRenderCounter } = await import("./render-counts");
  await installRenderCounter(page);
  const registration = { ownerUserId: "owner", machineId: "machine", harness: "codex" };
  const channel = { ...E2E_CHANNEL, memberPresence: {}, instanceRecords: [], messageCount: 1, historyHeadSequence: 1 };
  const instance = { id: `${channel.id}:1`, channelId: channel.id, channelInstanceId: "1", label: "codex:1",
    agentName: "codex", registration, connectedAt: E2E_NOW, lastSeenAt: E2E_NOW, status: "busy",
    revision: { version: 2, sequence: 1 } };
  const incoming = { messageId: "canonical-reply", channelId: channel.id, sequence: 1, sentAt: E2E_NOW,
    body: "I am running before the directory catches up.", from: { kind: "agent", identityId: "agent:codex",
      instanceId: instance.id, channelInstanceId: "1", instanceLabel: "codex:1", registration,
      label: "codex:1", userId: "owner", email: "" } };
  let send: ((frame: unknown) => void) | undefined;
  await routeHumanSocket(page, (frame, reply) => {
    if (frame.type === "human_connect") send = reply;
    if (frame.type === "ping") reply({ type: "pong", requestId: frame.requestId });
    if (frame.type === "user_focus_channel") reply({ type: "channel_history", requestId: frame.requestId,
      channelId: channel.id, messages: [incoming], hasMore: false });
  });
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
  await fixtureJson(page, "canonical-history", "**/api/xmatrix/channels/channel-general/history**", { messages: [incoming], hasMore: false });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const row = page.locator('[id="message:canonical-reply"]');
  await expect(row.getByText(incoming.body, { exact: true })).toBeVisible();
  await expect(row.getByText("instance offline", { exact: true })).toHaveCount(0);
  await expect.poll(() => Boolean(send)).toBe(true);
  // The connect snapshot never arrived: the report must introduce itself.
  send!({ type: "instance_records", records: [instance] });
  const dock = page.locator(".app-agent-work-dock");
  await expect(dock.getByRole("button", { name: /Open codex/ })).toBeVisible();
  await expect(row.getByRole("button", { name: "codex:1 Agent busy", exact: true })).toHaveCount(1);
  // The late/empty directory is a query window, never a roster removal.
  send!({ type: "channel_updated", channel });
  await expect(dock.getByRole("button", { name: /Open codex/ })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => { (window as unknown as { __renderCounts: { counting: boolean } }).__renderCounts.counting = true; });
  for (let sequence = 2; sequence <= 20; sequence++) send!({ type: "instance_activity", activities: [
    { instanceId: instance.id, channelId: channel.id, activity: `Working ${sequence}`, revision: { version: 2, sequence } },
  ] });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as unknown as { __renderCounts: { messageRows: number } }).__renderCounts.messageRows)).toBe(0);
  // A stop wins even against a later-delivered old socket report with a future clock.
  send!({ type: "instance_records", records: [{ ...instance, status: "offline", revision: { version: 3, sequence: 0 } }] });
  send!({ type: "instance_records", records: [{ ...instance, lastSeenAt: "2099-01-01T00:00:00Z", revision: { version: 2, sequence: 999 } }] });
  await expect(row.getByText("instance offline", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "codex:1 Agent offline", exact: true })).toHaveCount(1);
  await expect(dock.getByRole("button", { name: /Open codex/ })).toHaveCount(0);
  await row.locator(".identity-avatar").hover();
  await expect(row.getByRole("button", { name: /Reborn/ })).toBeVisible();
  send!({ type: "instance_records", records: [{ ...instance, status: "idle", revision: { version: 4, sequence: 1 } }] });
  await expect(row.getByText("instance offline", { exact: true })).toHaveCount(0);
  await expect(dock.getByRole("button", { name: /Open codex/ })).toBeVisible();
  await expect(row.getByRole("button", { name: /Reborn/ })).toHaveCount(0);
  // A stop missed while backgrounded is answered by exact ID, including ended
  // rows; the ordinary live/resting catalog window deliberately omits it.
  await fixtureJson(page, "canonical-exact", "**/api/xmatrix/channels/resolve", {
    protocolVersion: 1, channels: [{ ...channel, instanceRecords: [{ ...instance, status: "offline",
      revision: { version: 5, sequence: 0 } }], missingInstanceIds: [] }], pathsByChannelId: {},
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(row.getByText("instance offline", { exact: true })).toBeVisible();
  expect(await fixtureRequestBodies(page, "canonical-exact")).toContainEqual(expect.objectContaining({
    knownInstanceIds: [instance.id], includeParticipants: true,
  }));
});
