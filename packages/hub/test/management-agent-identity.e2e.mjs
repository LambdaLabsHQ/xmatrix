import { stopAgentWorker } from "./support/agent-worker.mjs";
import { startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";
import {
  assert,
  connectAgent,
  json,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  runAgentConnection,
  test,
  waitForChannelHistoryMessage,
} from "./agent-mention-spawn.fixture.mjs";
import {
  admitRegisteredSpawn, connectDaemon, createRoutableAgent, homeSpaceId, testMachine,
} from "./agent-launch-postgres.fixture.mjs";

test("management setup reuses its existing system Channel when the config lost its reference", async () => {
  const userId = `management-channel-reconcile-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "management-channel-reconcile@example.com", name: "Management Channel Reconcile" });
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const rootResult = await json(await worker.fetch("/api/channels", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ spaceId: await homeSpaceId(worker), mode: "open", name: `management-root-${randomUUID()}` }),
    }));
    const endpoint = `/api/spaces/${encodeURIComponent(rootResult.channel.spaceId)}/management-agent`;

    const initiallyConfigured = await worker.fetch(endpoint, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(initiallyConfigured.status, 200, await initiallyConfigured.clone().text());
    const initial = await json(initiallyConfigured);
    const managementChannelId = initial.space.managementAgent.managementChannelId;
    assert.equal(initial.managementChannel.id, managementChannelId);

    const cleared = await worker.fetch(endpoint, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ managementChannelId: null }),
    });
    assert.equal(cleared.status, 200, await cleared.clone().text());

    const reconciled = await worker.fetch(endpoint, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(reconciled.status, 200, await reconciled.clone().text());
    const payload = await json(reconciled);
    assert.equal(payload.space.managementAgent.managementChannelId, managementChannelId);
    assert.equal(payload.managementChannel.id, managementChannelId);
    assert.equal(payload.managementChannel.metadata.kind, "xmatrix_management");
    assert.equal(payload.managementChannel.metadata.systemOwned, true);
  } finally {
    await worker.stop();
  }
});

test("a management reply is presented as xMatrix, never as the registered Agent running it", async () => {
  const userId = `management-identity-e2e-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "management-identity-e2e@example.com", name: "Management Identity E2E" });
  let daemon;
  let agent;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const { hostId, machineId } = testMachine("management-identity");
    const channelResult = await json(await worker.fetch("/api/channels", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ spaceId: await homeSpaceId(worker), mode: "closed", name: `management-${randomUUID()}`, access: [] }),
    }));
    const channel = channelResult.channel;
    const channelId = channel.id;
    daemon = await connectDaemon(worker, { machineId, hostId });
    await createRoutableAgent(worker, { token: MOCK_TOKEN, spaceId: channel.spaceId,
      name: "codex-management-delegate", machineId, hostId });
    const configured = await worker.fetch(
      `/api/spaces/${encodeURIComponent(channel.spaceId)}/management-agent`,
      {
        method: "PATCH",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
    assert.equal(configured.status, 200);

    const spawn = daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent"
        && message.channelId === channelId
        && message.registration !== undefined && message.managementSpaceId === channel.spaceId,
      "xMatrix management spawn",
    );
    const mentioned = await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: "@xMatrix reply with the management identity" }),
    });
    assert.equal(mentioned.status, 200);

    const command = await spawn;
    assert.equal(command.exitAfterInitialMessage, undefined, "the @xMatrix delegate stays available");
    const runToken = await admitRegisteredSpawn(worker, daemon, command);
    agent = await connectAgent(worker, runAgentConnection(command, channelId, { machineId, hostId }), runToken);
    const joined = await agent.request({ type: "join_channel", channelId, historyLimit: 0 });
    assert.equal(joined.type, "channel_joined");

    await postChannelMessage(worker, runToken, channelId, "xMatrix management identity confirmed.");
    const delivered = await waitForChannelHistoryMessage(
      worker,
      MOCK_TOKEN,
      channelId,
      (message) => message.body === "xMatrix management identity confirmed.",
      "xMatrix management reply",
    );
    assert.equal(delivered.from.label, "xMatrix");
    assert.equal(delivered.from.avatarUrl, "/brand/xmatrix-management-icon.png");
  } finally {
    await stopAgentWorker(worker, agent, daemon);
  }
});
