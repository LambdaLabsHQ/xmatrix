import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, E2E_USER_SENDER,
  fixtureJson, installWorkspaceStubs, routeHumanSocket,
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

test("two successive unknown Instance reports both obtain authoritative cards", async ({ page }) => {
  const { fixtureChannelCatalog } = await import("./workspace-fixtures");
  const initial = { ...E2E_CHANNEL, memberPresence: {} };
  let send: ((frame: unknown) => void) | undefined;
  await routeHumanSocket(page, (frame, reply) => {
    if (frame.type === "human_connect") send = reply;
    if (frame.type === "ping") reply({ type: "pong", requestId: frame.requestId });
    if (frame.type === "user_focus_channel") reply({ type: "channel_history",
      requestId: frame.requestId, channelId: initial.id, messages: [], hasMore: false });
  });
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [initial] });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await expect.poll(() => Boolean(send)).toBe(true);
  const members: Record<string, unknown> = {};
  for (const slot of [1, 2]) {
    const instance = { id: `rapid-${slot}`, channelId: initial.id, channelInstanceId: String(slot),
      label: `Claude:${slot}`, connectedAt: E2E_NOW, lastSeenAt: E2E_NOW, status: "idle" };
    members[instance.id] = { kind: "agent", label: "Claude", instances: [instance],
      registration: { ownerUserId: "owner", machineId: "machine", harness: "claude" } };
    await fixtureChannelCatalog(page, `rapid-authority-${slot}`, [{ ...initial, memberPresence: { ...members } }]);
    send!({ type: "enhanced_presence", agent: { id: instance.id, instanceId: instance.id, name: "Claude",
      userId: "owner", type: "claude", lifetime: "short", email: "", metadata: {},
      status: "idle", connectedAt: E2E_NOW, lastSeenAt: E2E_NOW, instances: [instance] } });
    await expect(page.locator(".app-agent-work-avatar")).toHaveCount(slot);
  }
  await expect(page.locator(".app-agent-work-avatar img")).toHaveCount(2);
});
