import assert from "node:assert/strict";
import test from "node:test";
import {
  admitRegisteredSpawn, connectAgent, homeSpaceId, inTestTransaction, json, MOCK_TOKEN, randomUUID,
  REGISTERED_DAEMON_CAPABILITIES, startPgHubWorker,
} from "./agent-launch-postgres.fixture.mjs";
import { channelHistory, runAgentConnection, waitForChannelHistoryMessage } from "./agent-mention-spawn.fixture.mjs";
import { registerTestAgent } from "./registration-launch.fixture.mjs";

/**
 * A handoff carries the predecessor's conversation to a successor of another
 * harness on another machine, end to end against a local Hub on PostgreSQL.
 * The source is a claude Instance in a private managed directory (no
 * repository), as a page co-write is. `@claude:<n>:handoff:@codex` asks
 * machine A to stop it and export its conversation; machine B's spawn of
 * codex carries that conversation and tells codex where to read it.
 */

const machineA = "machine:5b0c7a1e9d3f4c2a8e6b1d0f9a7c3e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c";
const machineB = "machine:9e1d3c5b7a9f2e4d6c8b0a1f3e5d7c9b2a4f6e8d0c1b3a5f7e9d2c4b6a8f0e1d";

test("a handoff of a directory without a repository stops the source and gives its conversation to the successor", async () => {
  const userId = `handoff-conversation-${randomUUID()}`;
  let worker, daemonA, daemonB, source;
  try {
    worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      // The bundled local routing decision answers every question; the key only enables the path.
      JEV_AI_GATEWAY_API_KEY: "local-routing-decision",
      XMATRIX_MOCK_AUTH_USER_ID: userId, XMATRIX_MOCK_AUTH_EMAIL: "handoff-conversation@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Handoff Conversation" } });
    const headers = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const spaceId = await homeSpaceId(worker);
    const { channel } = await json(await worker.fetch("/api/channels", { method: "POST", headers,
      body: JSON.stringify({ spaceId, mode: "closed", name: `handoff-conversation-${randomUUID()}`, access: [] }) }));
    const hostA = `conversation-host-a-${randomUUID()}`, hostB = `conversation-host-b-${randomUUID()}`;
    const daemon = (machineId, hostId) => connectAgent(worker, { name: `xmatrix-daemon-${hostId}`, agentType: "xmatrix_daemon",
      metadata: { kind: "daemon", machineId, hostId, hostName: hostId, capabilities: REGISTERED_DAEMON_CAPABILITIES } });
    daemonA = await daemon(machineA, hostA);
    daemonB = await daemon(machineB, hostB);
    // No registered directory: each works in a private managed one, as a page co-write does.
    await registerTestAgent(worker, { token: MOCK_TOKEN, spaceId, harness: "claude", machineId: machineA });
    await registerTestAgent(worker, { token: MOCK_TOKEN, spaceId, harness: "codex", machineId: machineB });

    // claude starts on machine A in a private managed directory.
    const spawnA = daemonA.inbox.waitFor(message => message.type === "machine_spawn_agent" && message.channelId === channel.id,
      "claude spawn on machine A");
    const summon = await worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/messages`, { method: "POST", headers,
      body: JSON.stringify({ body: `@claude machine:${machineA} plan the Bali trip` }) });
    assert.equal(summon.status, 200, await summon.clone().text());
    const launch = await spawnA;
    assert.match(launch.workspace.canonicalCwd, /^\.xmatrix-management\//u);
    assert.equal(launch.remoteRepo, undefined);
    assert.equal(launch.handoffContext, undefined, "an ordinary summon carries no conversation");
    const token = await admitRegisteredSpawn(worker, daemonA, launch);
    source = await connectAgent(worker, runAgentConnection(launch, channel.id, { machineId: machineA, hostId: hostA }), token);
    assert.equal((await source.request({ type: "join_channel", channelId: channel.id, historyLimit: 0 })).type, "channel_joined");
    const [instance] = await inTestTransaction(tx => tx.query({
      text: "SELECT channel_instance_id FROM data.instances WHERE instance_id=$1", values: [launch.instanceId] }));

    // The owner hands it to codex.
    const stopA = daemonA.inbox.waitFor(message => message.type === "machine_stop_agent" && message.runId === launch.runId,
      "handoff stop on machine A", 30_000);
    // The handoff's response waits for the handoff, so machine A answers meanwhile.
    const handoff = worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/messages`, { method: "POST", headers,
      body: JSON.stringify({ body: `@claude:${instance.channel_instance_id}:handoff:@codex` }) });

    // Machine A stops the source, names its session and exports its conversation.
    const stop = await stopA;
    assert.equal(stop.worktreeDisposition, "retain");
    assert.equal(stop.handoffExport, undefined, "only a repository checkout is pushed");
    assert.equal(stop.resumeSessionKey, launch.resumeSessionKey,
      "the stop names the session its status is read back under, or the Hub refuses its own command");
    assert.deepEqual(stop.handoffContext, { maxChars: 60_000 });
    const handoffContext = { format: "xmatrix.handoff-context.v1", harness: "claude", sessionId: "session-a",
      entries: [{ role: "user", text: "plan the Bali trip" }, { role: "assistant", text: "Booked Grandmas Plus Legian." },
        { role: "tool_call", tool: "Bash", text: "{\"command\":\"xmatrix page read\"}" }, { role: "tool_result", text: "# 巴厘岛度假规划" }],
      omittedEntries: 0 };
    const spawnB = daemonB.inbox.waitFor(message => message.type === "machine_spawn_agent" && message.channelId === channel.id,
      "codex spawn on machine B", 30_000);
    // As a daemon does: admit the stop, then report it.
    daemonA.ws.send(JSON.stringify({ type: "machine_command_admitted", requestId: `admit:${stop.requestId}`,
      controlId: stop.requestId, admittedAt: new Date().toISOString(), relayLease: stop.relayLease }));
    daemonA.ws.send(JSON.stringify({ type: "machine_stop_result", requestId: stop.requestId, runId: stop.runId,
      executionKey: stop.executionKey, agentId: stop.agentId, instanceId: stop.instanceId,
      resumeSessionKey: stop.resumeSessionKey, worktreeDisposition: stop.worktreeDisposition, ok: true, pid: 4242,
      cleanupReason: "process_terminated", handoffContext, relayLease: stop.relayLease }));

    const posted = await handoff;
    assert.equal(posted.status, 200, await posted.clone().text());

    // codex starts on machine B with the conversation.
    const successor = await spawnB.catch(async error => {
      const seen = await channelHistory(worker, MOCK_TOKEN, channel.id);
      throw new Error(`${error.message}; Channel: ${JSON.stringify(seen.messages.map(message => message.body))}`);
    });
    assert.equal(successor.registration.key.machineId, machineB);
    assert.equal(successor.registration.key.harness, "codex");
    assert.deepEqual(successor.handoffContext, handoffContext);
    assert.match(successor.prompt, /@claude:\d+ handed its work to you/);
    assert.match(successor.prompt, /HANDOFF\.md/);
    assert.match(successor.prompt, /never resume it/);
    assert.doesNotMatch(successor.prompt, /Grandmas/, "the conversation is not the launch's text");

    const history = await channelHistory(worker, MOCK_TOKEN, channel.id);
    assert.equal(history.messages.filter(message => /could not hand off/u.test(message.body ?? "")).length, 0,
      JSON.stringify(history.messages.map(message => message.body)));
    await waitForChannelHistoryMessage(worker, MOCK_TOKEN, channel.id,
      message => /:handoff:@codex$/u.test(message.body ?? ""), "handoff message", 5_000);
  } finally {
    source?.ws?.close();
    daemonA?.ws?.close();
    daemonB?.ws?.close();
    await worker?.stop();
  }
});
