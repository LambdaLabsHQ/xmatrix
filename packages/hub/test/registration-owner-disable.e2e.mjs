import assert from "node:assert/strict";
import test from "node:test";
import {
  admitRegisteredSpawn, connectAgent, json, launchMentionedCodexRun, MOCK_TOKEN, randomUUID, startPgHubWorker,
} from "./agent-launch-postgres.fixture.mjs";
import { runAgentConnection } from "./agent-mention-spawn.fixture.mjs";

// An owner disables their Agent on its machine, or a Space admin disables it in
// the Space: its running Instance is stopped, and it stays unavailable until
// whoever disabled it enables it.
test("an owner's or a Space admin's Disable stops the Agent's running work and Enable restores it", async () => {
  const userId = `registration-disable-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "registration-disable@example.com", XMATRIX_MOCK_AUTH_NAME: "Registration Disable",
  } });
  let daemon;
  let agent;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const post = (route, body) => worker.fetch(route, { method: "POST", headers: auth, body: JSON.stringify(body) });
    const run = await launchMentionedCodexRun(worker, { ownerUserId: userId, slug: "disable", displayName: "eevee",
      mention: "@codex please check the build" });
    ({ daemon, agent } = run);
    const { command, machineId, channel, spaceId } = run;

    const physical = { ownerUserId: userId, machineId, harness: "codex" };
    const setEnabled = async enabled => {
      const current = await json(await post("/api/agent-environments/query", physical));
      const changed = await post("/api/agent-environments/commands", { key: physical, commandId: `toggle:${randomUUID()}`,
        expectedVersion: current.version, environment: { ...current.environment, enabled } });
      assert.equal(changed.status, 200, await changed.clone().text());
    };
    const catalogRow = async () => (await json(await worker.fetch(`/api/spaces/${encodeURIComponent(spaceId)}/agent-registrations`,
      { headers: auth }))).registrations.find(row => row.key.machineId === machineId);

    const before = await catalogRow();
    const stopped = daemon.inbox.waitFor(message => message.type === "machine_stop_agent"
      && message.runId === command.runId, "disabled Agent stop");
    await setEnabled(false);
    const stop = await stopped;
    assert.equal(stop.instanceId, command.instanceId);
    const disabled = await catalogRow();
    assert.equal(disabled.state, "enabled", "disabling is not a Space state");
    assert.equal(disabled.routingBlocker, "owner_environment_disabled");
    assert.equal(disabled.routingReady, false);

    // The host confirms the stop; the disabled Agent is then offered to nobody.
    agent.ws.close();
    agent = undefined;
    daemon.ws.send(JSON.stringify({ type: "machine_stop_result", requestId: stop.requestId, runId: stop.runId,
      executionKey: stop.executionKey, agentId: stop.agentId, instanceId: stop.instanceId,
      ...(stop.worktreeDisposition ? { worktreeDisposition: stop.worktreeDisposition } : {}),
      ok: true, pid: 4242, relayLease: stop.relayLease }));
    const mention = body => post(`/api/channels/${encodeURIComponent(channel.id)}/messages`, { body });
    const refused = daemon.inbox.waitFor(message => message.type === "machine_spawn_agent"
      && message.channelId === channel.id && message.runId !== command.runId, "disabled spawn", 3_000);
    assert.equal((await mention("@codex while disabled")).status, 200);
    await assert.rejects(refused, "a disabled Agent is not launched");

    await setEnabled(true);
    assert.equal((await catalogRow()).routingBlocker, before.routingBlocker, "enabling restores what it was");
    const respawn = daemon.inbox.waitFor(message => message.type === "machine_spawn_agent"
      && message.channelId === channel.id && message.runId !== command.runId, "enabled spawn");
    assert.equal((await mention("@codex after enabling")).status, 200);
    const second = await respawn;

    // A Space owner/admin disables it in this Space: its running work here stops too.
    const secondToken = await admitRegisteredSpawn(worker, daemon, second);
    agent = await connectAgent(worker, runAgentConnection(second, channel.id, run), secondToken);
    const registrationKey = { spaceId, ...physical };
    const setSpaceState = async state => {
      const current = await json(await post(`/api/spaces/${encodeURIComponent(spaceId)}/agent-registrations/query`, registrationKey));
      const changed = await post(`/api/spaces/${encodeURIComponent(spaceId)}/agent-registrations/commands`, { action: "space-state",
        key: registrationKey, commandId: `space:${randomUUID()}`, state, expectedRevision: current.access.policy.revision });
      assert.equal(changed.status, 200, await changed.clone().text());
    };
    const spaceStopped = daemon.inbox.waitFor(message => message.type === "machine_stop_agent"
      && message.runId === second.runId, "Space-disabled Agent stop");
    await setSpaceState("disabled");
    await spaceStopped;
    assert.equal((await catalogRow()).state, "disabled");
    await setSpaceState("enabled");
    assert.equal((await catalogRow()).state, "enabled");
  } finally {
    agent?.ws?.close();
    daemon?.ws?.close();
    await worker.stop();
  }
});
