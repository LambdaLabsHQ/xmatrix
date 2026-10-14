import { HUMAN_CLIENT_PRESENCE_DIGEST, type ChannelAttentionSummary, type ChannelMessage } from "@xmatrix/protocol";
import { expect, test, type Page } from "./fixtures";
import {
  readNativeHumanSocketTraffic,
  routeNativeHumanSocket,
  type NativeHumanSocketControl,
  type NativeHumanSocketTraffic,
} from "./native-human-socket-fixture";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_USER_SENDER,
  fixtureJson,
  fixtureRule,
  type HumanSocketFrame,
  routeHumanSocket,
} from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

test.use({ ...E2E_DESKTOP_CONTEXT, humanSocketWorker: true });

type Peer = { reply(message: unknown): void; control: NativeHumanSocketControl };

async function openNativeWorker(page: Page) {
  const space = workingAgentsSpace(2, "human-worker", { intent: "Check native Worker delivery" });
  space.channels = space.channels.map(channel => ({
    ...channel,
    readSequence: channel.id === E2E_CHANNEL.id ? 40 : 38,
  }));
  const history: unknown[] = channelHistory(40, "worker-history", row => `Worker history row ${row}`);
  const peers = new Map<number, Peer>();
  const handshakes = new Map<number, HumanSocketFrame>();
  const focuses = new Map<number, HumanSocketFrame>();
  let physicalConnections = () => 0;
  const routeSocket: typeof routeHumanSocket = async (ownerPage, onFrame) => {
    const native = await routeNativeHumanSocket(ownerPage, (frame, reply, connection, control) => {
      peers.set(connection, { reply, control });
      if (frame.type === "human_connect") handshakes.set(connection, frame);
      if (frame.type === "user_focus_channel") focuses.set(connection, frame);
      onFrame(frame, reply, connection);
    });
    physicalConnections = native.connections;
    return native;
  };
  const send = await openWorkingAgentsSpace(page, space, history, "Worker history row 40", { routeSocket });
  await expect.poll(async () => (await readNativeHumanSocketTraffic(page)).workerConnections).toBe(1);
  expect(handshakes.get(1)).toMatchObject({
    type: "human_connect",
    requestId: "web-subscribe",
    token: expect.any(String),
    device: { capabilities: expect.arrayContaining([HUMAN_CLIENT_PRESENCE_DIGEST]) },
  });
  await expect.poll(() => focuses.get(1)?.channelId).toBe(E2E_CHANNEL.id);
  expect(focuses.get(1)).toMatchObject({
    channelId: E2E_CHANNEL.id,
    requestId: `focus-history:${E2E_CHANNEL.id}`,
  });
  await page.evaluate(() => {
    (window as unknown as { __nativeHumanSocketTraffic: NativeHumanSocketTraffic }).__nativeHumanSocketTraffic.counting = true;
  });

  const peer = (connection = 1): Peer => {
    const value = peers.get(connection);
    if (!value) throw new Error(`The native Worker has not connected socket ${connection}`);
    return value;
  };
  const message = (sequence: number, body: string, agentIndex = 0): ChannelMessage => {
    const agent = space.agents[agentIndex]!;
    const instance = agent.instances[0]!;
    return {
      messageId: `worker-live-${agentIndex}-${sequence}`,
      channelId: space.channelId(agentIndex),
      sequence,
      body,
      sentAt: new Date(Date.parse(E2E_NOW) + sequence * 1_000).toISOString(),
      from: {
        kind: "agent", identityId: agent.id, userId: agent.userId, email: agent.email,
        label: instance.label, agentName: agent.name, instanceId: instance.id,
        channelInstanceId: instance.channelInstanceId, instanceLabel: instance.label,
      },
      reactions: [], attachments: [],
    };
  };
  return { space, history, handshakes, focuses, send, peer, message, physicalConnections: () => physicalConnections() };
}

function attention(channelId: string, count: number, sequence: number): ChannelAttentionSummary {
  return {
    channelId, unreadAttentionCount: count, lastMessageId: `worker-live-1-${sequence}`,
    lastMessageSequence: sequence, primaryTriggerKind: "mention", triggerKinds: ["mention"],
    targetKind: "user", updatedAt: new Date(Date.parse(E2E_NOW) + sequence * 1_000).toISOString(),
  };
}

async function expectWorkerConnections(
  page: Page,
  owner: Pick<Awaited<ReturnType<typeof openNativeWorker>>, "send" | "physicalConnections">,
  count = 1,
): Promise<NativeHumanSocketTraffic> {
  const traffic = await readNativeHumanSocketTraffic(page);
  expect(traffic.connections).toBe(count);
  expect(traffic.workerConnects).toBe(count);
  expect(traffic.workerConnections).toBe(count);
  expect(owner.send.connections()).toBe(count);
  expect(owner.physicalConnections()).toBe(count);
  return traffic;
}

test("native Worker preserves state before live messages and control frames", async ({ page }) => {
  const owner = await openNativeWorker(page);
  const other = owner.space.channels[1]!;
  const row = page.locator(`[data-channel-row-id="${other.id}"]`);
  await expect(row.getByTitle(`Unread messages in #${other.name}`)).toHaveText("2");
  // Keep HTTP repairs pending: the final badge/topic must come from these
  // ordered socket frames, even if a catalog invalidation starts a read.
  await fixtureRule(page, {
    id: "worker-order-catalog",
    pattern: /\/api\/xmatrix\/channels\/(?:page|resolve)(?:\?.*)?$/u,
    responder: { kind: "channelCatalog", channels: owner.space.channels, held: true },
  });

  owner.send({ type: "channel_updated", channel: { ...other, readSequence: 38, attention: attention(other.id, 2, 40) } });
  const incoming = owner.message(41, "The message follows its Channel state.", 1);
  owner.send({ type: "channel_message_received", message: incoming,
    notification: { reason: "mention", attention: attention(other.id, 3, 41) } });
  await expect(row.getByTitle(`Unread mention in #${other.name}`)).toHaveText("3");
  await expect(row).toContainText(incoming.body);

  const stateTopic = "Deferred state before the topic control";
  const controlTopic = "The later topic control wins";
  owner.send({ type: "channel_updated", channel: { ...owner.space.channels[0]!, topic: stateTopic } });
  owner.send({ type: "channel_topic_updated", channelId: E2E_CHANNEL.id, topic: controlTopic,
    updatedBy: E2E_USER_SENDER, updatedAt: incoming.sentAt });
  await expect(page.locator(".app-panel-header").getByText(controlTopic, { exact: true })).toBeVisible();
  await expect(page.locator(".app-panel-header").getByText(stateTopic, { exact: true })).toHaveCount(0);
  const traffic = await expectWorkerConnections(page, owner);
  expect(traffic.byType.channel_updated).toBe(2);
  expect(traffic.byType.channel_message_received).toBe(1);
  expect(traffic.byType.channel_topic_updated).toBe(1);
});

test("a malformed native frame does not discard its valid neighbors or replace the Worker", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const owner = await openNativeWorker(page);
  owner.send(owner.space.report(0, "Step 10")[0]);
  owner.peer().control.sendRaw("{not valid JSON");
  owner.send({ type: "space_channel_catalog_changed", spaceId: 42, revision: "invalid" });
  const incoming = owner.message(41, "A good message after the malformed native frame.");
  owner.send({ type: "channel_message_received", message: incoming });
  await expect(page.locator(".app-message-row", { hasText: incoming.body })).toHaveCount(1);
  await fixtureJson(page, "worker-final-trace", "**/api/xmatrix/trace/instances/instance-human-worker-0/events?**",
    { availability: "available", complete: true, events: [], cursor: null, nextCursor: null });
  await page.locator(".app-agent-work-dock").getByRole("button", { name: /^Open agent0 -/u }).click();
  await expect(page.getByRole("dialog").getByText("Step 10", { exact: true })).toBeVisible();
  const traffic = await expectWorkerConnections(page, owner);
  expect(traffic.byType.unknown).toBe(1);
  expect(traffic.byType.enhanced_presence).toBe(1);
  expect(traffic.byType.space_channel_catalog_changed).toBe(1);
  expect(traffic.byType.channel_message_received).toBe(1);
  expect(errors).toEqual([]);
});

test("a server close reconnects the native Worker and restores focused delivery", async ({ page }) => {
  const owner = await openNativeWorker(page);
  const first = owner.message(41, "The native message before server close.");
  owner.history.push(first);
  owner.send({ type: "channel_message_received", message: first });
  await expect(page.locator(".app-message-row", { hasText: first.body })).toHaveCount(1);
  owner.peer().control.close(4000, "Worker owner reconnect");
  await expect.poll(() => owner.handshakes.size, { timeout: 10_000 }).toBe(2);
  await expect.poll(() => owner.focuses.get(2)?.channelId).toBe(E2E_CHANNEL.id);
  expect(owner.handshakes.get(2)).toMatchObject({ type: "human_connect", requestId: "web-subscribe" });
  const second = owner.message(42, "The native message after Worker reconnect.");
  owner.history.push(second);
  owner.peer(2).reply({ type: "channel_message_received", message: second });
  await expect(page.locator(".app-message-row", { hasText: first.body })).toHaveCount(1);
  await expect(page.locator(".app-message-row", { hasText: second.body })).toHaveCount(1);
  await expect.poll(async () => (await readNativeHumanSocketTraffic(page)).workerConnections).toBe(2);
  const traffic = await expectWorkerConnections(page, owner, 2);
  expect(traffic.workerPackets).toBeGreaterThan(0);
});
