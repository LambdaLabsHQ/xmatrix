import { stopAgentWorker } from "./support/agent-worker.mjs";
import { startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";
import {
  assert,
  connectAgent,
  json,
  mintAgentRunToken,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  runAgentConnection,
  sleep,
  test,
} from "./agent-mention-spawn.fixture.mjs";
import {
  createPgSpawnableScenario, isSpawnOf, sendSpawnResult, sendStopResult,
} from "./agent-launch-postgres.fixture.mjs";

async function waitForInstanceRetirement(worker, auth, channelId, instanceId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [live, catalog] = await Promise.all([
      json(await worker.fetch("/api/agent-instances", { headers: auth })),
      json(await worker.fetch("/api/channels", { headers: auth })),
    ]);
    const channel = catalog.channels.find((candidate) => candidate.id === channelId);
    const channelInstances = channel?.memberPresence?.[instanceId]?.instances || [];
    if (!live.instances.some((instance) => instance.instanceId === instanceId) &&
        !channelInstances.some((instance) => instance.id === instanceId)) {
      return true;
    }
    await sleep(25);
  }
  return false;
}

async function assertInstanceRetired(worker, auth, channelId, instanceId, message) {
  assert.equal(await waitForInstanceRetirement(worker, auth, channelId, instanceId), true, message);
}

async function spawnTerminalRun(worker, scenario, prompt, label) {
  await postChannelMessage(worker, MOCK_TOKEN, scenario.channelId,
    `@auto harness:codex machine:${scenario.machineId} pwd:"${scenario.workspace.canonicalCwd}" ${prompt}`);
  return scenario.daemon.inbox.waitFor(message => message.type === "machine_spawn_agent" &&
    message.channelId === scenario.channelId && isSpawnOf(message, scenario.registration), label);
}

async function connectTerminalRun(worker, daemon, spawn, channelId, pid) {
  const runToken = await mintAgentRunToken(worker, daemon, spawn, channelId);
  sendSpawnResult(daemon, spawn, { ok: true, pid });
  const agent = await connectAgent(worker, runAgentConnection(spawn, channelId), runToken);
  return { agent, runToken };
}

test("daemon exit retires an Agent Instance when Agent unregister never arrives", async () => {
  const unique = randomUUID();
  const userId = `Agent-terminal-cleanup-${unique}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "Agent-terminal-cleanup@example.com", name: "Agent Terminal Cleanup" });
  let daemon;
  let agent;
  try {
    const scenario = await createPgSpawnableScenario(worker, {
      unique, agentName: "codex-Agent-terminal-cleanup",
    });
    ({ daemon } = scenario);
    const { auth, channelId } = scenario;

    const spawn = await spawnTerminalRun(worker, scenario, "finish exactly one task", "Agent spawn");
    assert.equal(spawn.exitAfterInitialMessage, undefined);
    const { agent: connectedAgent } = await connectTerminalRun(worker, daemon, spawn, channelId, 4242);
    agent = connectedAgent;
    const instanceId = agent.agent.instanceId || agent.agent.id;

    const liveBeforeExit = await json(await worker.fetch("/api/agent-instances", {
      headers: auth,
    }));
    assert.ok(
      liveBeforeExit.instances.some((instance) => instance.instanceId === instanceId),
      "the Agent socket must be live before daemon terminal evidence",
    );

    const shutdown = agent.inbox.waitFor(
      (message) => message.type === "shutdown_requested",
      "Runtime Agent terminal purge",
    );
    daemon.ws.send(JSON.stringify({
      type: "machine_run_exited",
      runId: spawn.runId,
      executionKey: spawn.executionKey,
      agentId: spawn.identityId,
      agentName: spawn.agentName,
      pid: 4242,
      status: "exit status: 0",
      exitCode: 0,
      completed: true,
      delivered: true,
    }));
    await shutdown;

    await assertInstanceRetired(worker, auth, channelId, instanceId, "authenticated Agent exit must clear Runtime and Authority Instance presence");
  } finally {
    await stopAgentWorker(worker, agent, daemon);
  }
});

test("an Agent continues after a PR progress reply and stops only when it chooses", async () => {
  const unique = randomUUID();
  const userId = `terminal-stop-stale-presence-${unique}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "terminal-stop-stale-presence@example.com", name: "Terminal Stop Stale Presence" });
  let daemon;
  let agent;
  try {
    const scenario = await createPgSpawnableScenario(worker, {
      unique, agentName: "codex-terminal-stop-stale-presence",
    });
    ({ daemon } = scenario);
    const { auth, channelId } = scenario;

    const spawn = await spawnTerminalRun(worker, scenario, "remain available after the first task", "persistent spawn for terminal cleanup");
    const { runToken, agent: connectedAgent } = await connectTerminalRun(worker, daemon, spawn, channelId, 4343);
    agent = connectedAgent;
    const instanceId = agent.agent.instanceId || agent.agent.id;

    const shutdown = agent.inbox.waitFor(
      (message) => message.type === "shutdown_requested",
      "Runtime persistent terminal purge",
    );
    const result = await postChannelMessage(worker, runToken, channelId, "PR opened; waiting for CI before finishing.");
    const ordinal = result.message.from.channelInstanceId;
    assert.ok(ordinal, "the Agent's own published message carries its exact Channel ordinal");
    // Posting a first-turn progress reply is not terminal evidence. A later CI
    // result must reach this same Instance so it can finish the work it promised.
    const continued = agent.inbox.waitFor(message => message.type === "channel_message_received" &&
      message.message?.body?.includes("CI failed; repair the PR"), "CI follow-up after first reply");
    await postChannelMessage(worker, MOCK_TOKEN, channelId, `@${spawn.agentName}:${ordinal} CI failed; repair the PR`);
    const followup = await continued;
    assert.equal(followup.message.channelId, channelId);
    const finalResult = await postChannelMessage(worker, runToken, channelId, "CI repaired and verified; work complete.");
    assert.equal(finalResult.message.from.instanceId, instanceId);
    assert.equal(finalResult.message.from.channelInstanceId, ordinal);

    const requested = daemon.inbox.waitFor(message => message.type === "machine_stop_agent" &&
      message.runId === spawn.runId, "Agent-authored self-stop");
    await postChannelMessage(worker, runToken, channelId, `@${spawn.agentName}:${ordinal}:stop work complete`);
    const stop = await requested;
    assert.equal(stop.instanceId, spawn.instanceId);
    assert.equal(stop.executionKey, spawn.executionKey);
    sendStopResult(daemon, stop, { channelId, ok: true, pid: 4343 });
    await shutdown;

    await assertInstanceRetired(worker, auth, channelId, instanceId, "an authenticated self-stop must clear Runtime and Authority Instance presence");
  } finally {
    await stopAgentWorker(worker, agent, daemon);
  }
});
