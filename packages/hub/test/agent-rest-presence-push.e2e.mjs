import { stopAgentWorker } from "./support/agent-worker.mjs";
import { websocketInbox } from "./support/websocket-inbox.mjs";
import { humanWsUrl, openWebSocket } from "./e2e-utils.mjs";
import { createPgSpawnableScenario, isSpawnOf, sendSpawnResult, startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";
import {
  assert, connectAgent, mintAgentRunToken, MOCK_TOKEN, postChannelMessage, randomUUID, runAgentConnection, test,
} from "./agent-mention-spawn.fixture.mjs";

/** The Agents a `presence_updated` push carries for its Channel, by Instance. */
function pushedInstances(message, channelId) {
  if (message.type !== "observable_event" || message.event?.type !== "presence_updated" ||
      message.event.channelId !== channelId || message.event.metadata?.presenceCoverage !== "agents") return null;
  return Object.values(message.event.metadata.memberPresence ?? {}).flatMap((member) => member.instances ?? []);
}

// An Instance's rest is recorded when its daemon reports the exit. The Hub
// pushes how the Channel's Agents then stand, so the Channel's lists merge
// it in place; nothing re-reads a list on a timer to find out.
test("a daemon's report that its Instance rests reaches the Channel's people with the Channel's Agents", async () => {
  const unique = randomUUID();
  const userId = `agent-rest-presence-${unique}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "agent-rest-presence@example.com",
    name: "Agent Rest Presence" });
  let daemon;
  let agent;
  let human;
  try {
    const scenario = await createPgSpawnableScenario(worker, { unique, agentName: "codex-agent-rest-presence" });
    ({ daemon } = scenario);
    const { channelId } = scenario;
    await postChannelMessage(worker, MOCK_TOKEN, channelId,
      `@auto harness:codex machine:${scenario.machineId} pwd:"${scenario.workspace.canonicalCwd}" answer, then rest`);
    const spawn = await daemon.inbox.waitFor((message) => message.type === "machine_spawn_agent" &&
      message.channelId === channelId && isSpawnOf(message, scenario.registration), "Agent spawn");
    const runToken = await mintAgentRunToken(worker, daemon, spawn, channelId);
    sendSpawnResult(daemon, spawn, { ok: true, pid: 4343 });
    agent = await connectAgent(worker, runAgentConnection(spawn, channelId), runToken);
    const instanceId = spawn.instanceId ?? spawn.identityId;

    const socket = await openWebSocket(humanWsUrl(worker, userId));
    human = { ws: socket, inbox: websocketInbox(socket) };
    socket.send(JSON.stringify({ type: "human_connect", token: MOCK_TOKEN, requestId: `connect-${unique}`,
      device: { client: "desktop", version: "0.16.160", protocolVersion: 2 } }));
    await human.inbox.waitFor((message) => message.type === "human_connected", "Human connected");

    const rested = human.inbox.waitFor((message) => pushedInstances(message, channelId)
      ?.some((instance) => instance.id === instanceId && instance.status === "offline" && instance.rest === "sleeping"),
    "the rest pushed with the Channel's Agents", 30_000);
    daemon.ws.send(JSON.stringify({ type: "machine_run_exited", runId: spawn.runId, executionKey: spawn.executionKey,
      agentId: spawn.identityId, agentName: spawn.agentName, pid: 4343, status: "exit status: 0", exitCode: 0,
      completed: false, delivered: false, restReason: "sleeping" }));
    const pushed = pushedInstances(await rested, channelId);
    assert.deepEqual(pushed.map((instance) => instance.id), [instanceId], "the push carries the Channel's Agents, and only them");
  } finally {
    await stopAgentWorker(worker, human, agent, daemon);
  }
});
