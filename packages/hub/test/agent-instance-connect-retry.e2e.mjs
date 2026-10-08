import {
  assert,
  connectAgent,
  mintAgentRunToken,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  test,
} from "./agent-mention-spawn.fixture.mjs";
import {
  createPgSpawnableScenario,
  isSpawnOf,
  startPgHubWorker,
} from "./agent-launch-postgres.fixture.mjs";

// Migrated from the retired `@<name>:new:<workspace>` grammar to the tagged
// `@auto harness:codex machine:<id> pwd:<path>` launch, which
// routes through the PostgreSQL launch authority. The double-connection
// assertion and the real HTTP authorization / machine_spawn_agent crossing are
// unchanged.
test("a retried Agent Instance connect succeeds after the predecessor already claimed presence", async () => {
  const userId = `connect-retry-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "connect-retry@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Connect Retry",
    },
  });
  let daemon;
  const sockets = [];
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-connect-retry" });
    ({ daemon } = scenario);
    const { channelId, registration, machineId, hostId, canonicalCwd } = scenario;

    await postChannelMessage(
      worker,
      MOCK_TOKEN,
      channelId,
      `@auto harness:codex machine:${machineId} pwd:"${canonicalCwd}" register twice`,
    );

    const spawn = await daemon.inbox.waitFor(
      (message) =>
        message.type === "machine_spawn_agent" &&
        message.channelId === channelId &&
        isSpawnOf(message, registration),
      "machine spawn",
    ).catch(async (error) => {
      const response = await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/history?limit=20`, {
        headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
      });
      throw new Error(`${error.message}; channel evidence: ${await response.text()}`, { cause: error });
    });
    const runToken = await mintAgentRunToken(worker, daemon, spawn, channelId);
    const body = {
      identityId: spawn.identityId,
      name: spawn.agentName,
      agentType: "codex",
      metadata: {
        tool: "codex",
        machineId,
        hostId,
        workspaceMachineId: spawn.workspace.machineId,
        workspaceCwd: spawn.workspace.canonicalCwd,
        cwd: spawn.workspace.canonicalCwd,
        runId: spawn.runId,
        executionKey: spawn.executionKey,
        autoJoinChannelId: channelId,
      },
    };
    // Finish the predecessor's handshake before retrying. Concurrent handshakes
    // can supersede the first connection before it has claimed presence, which
    // exercises a different race from this regression.
    sockets.push(await connectAgent(worker, body, runToken));
    sockets.push(await connectAgent(worker, body, runToken));
    assert.equal(sockets.length, 2);
  } finally {
    for (const socket of sockets) socket.ws.close();
    daemon?.ws.close();
    await worker.stop();
  }
});
