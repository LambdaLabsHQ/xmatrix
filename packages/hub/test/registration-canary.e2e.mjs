import assert from "node:assert/strict";
import test from "node:test";
import {
  admitRegisteredSpawn, connectAgent, inTestTransaction, launchMentionedCodexRun, MOCK_TOKEN, randomUUID,
  sendStopResult, startPgHubWorker,
} from "./agent-launch-postgres.fixture.mjs";
import { runAgentConnection, waitForChannelHistoryMessage } from "./agent-mention-spawn.fixture.mjs";

// The registration canary: an owner registers a harness on a daemon's machine,
// then an `@codex` from a Human reaches a registration Run end to end -- spawn,
// run credential, Agent connection, Channel join and an Agent-authored reply.
test("a registered Agent launches, authorizes and is heard end to end", async () => {
  const userId = `registration-canary-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "registration-canary@example.com", XMATRIX_MOCK_AUTH_NAME: "Registration Canary",
  } });
  let daemon;
  let agent;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    // The daemon admits a registered spawn before starting it: the Hub
    // re-checks the registration binding and admits the reserved capacity,
    // returning the Run credential the daemon starts with. The spawned Agent
    // then connects as its Instance and joins.
    const run = await launchMentionedCodexRun(worker, { ownerUserId: userId, slug: "canary", displayName: "eevee",
      mention: "@codex please check the build",
      launch: { runtime: "codex", backend: "codex-app", runtimeArgs: ["--full-auto"] } });
    ({ daemon, agent } = run);
    const { command, machineId, channel, spaceId } = run;
    assert.equal(command.context?.requestedModel, undefined, 'a cold runtime chooses its own model');
    assert.equal(command.context?.requestedEffort, undefined);
    assert.deepEqual(command.registration.key, { spaceId, ownerUserId: userId, machineId, harness: "codex" });
    assert.equal(command.identityId, command.instanceId, "a registered Agent acts as its Instance");
    assert.equal(command.runtime, "codex");
    assert.deepEqual(command.runtimeArgs, ["--full-auto"], "the Hub maintains the launch settings");
    assert.equal(command.agentBackend, "codex-app");
    assert.equal(command.harness?.id, "codex", "the Hub sends its harness preset");

    // The spawned Agent speaks.
    const dispatched = await agent.request({ type: "channel_message", channelId: channel.id, body: "registered canary is alive" });
    assert.equal(dispatched.type, "channel_message_dispatched", JSON.stringify(dispatched));
    const reply = await waitForChannelHistoryMessage(worker, MOCK_TOKEN, channel.id,
      message => message.body === "registered canary is alive", "registered Agent reply");
    assert.equal(reply.senderId ?? reply.authorId ?? command.instanceId, command.instanceId);

    // A Human addresses the registered Instance by its registration name and
    // Channel number; the message is delivered to that Instance.
    const ordinal = (await inTestTransaction(tx => tx.query({ text: "SELECT channel_instance_id FROM data.instances WHERE instance_id=$1",
      values: [command.instanceId] })))[0].channel_instance_id;
    const delivered = agent.inbox.waitFor(message => message.type === "channel_message_received"
      && String(message.message?.body ?? "").includes("status please"), "addressed delivery");
    const addressed = await worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/messages`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: `@eevee:${ordinal} status please` }),
    });
    assert.equal(addressed.status, 200, await addressed.clone().text());
    await delivered;

    // Reborn keeps the Instance and its session: the predecessor is stopped,
    // then a registration successor resumes on the same Instance.
    const predecessorStop = daemon.inbox.waitFor(message => message.type === "machine_stop_agent"
      && message.runId === command.runId, "registered reborn predecessor stop");
    const rebornPosted = await worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/messages`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: `@eevee:${ordinal}:reborn continue after restart` }),
    });
    assert.equal(rebornPosted.status, 200, await rebornPosted.clone().text());
    const rebornMessageId = (await rebornPosted.clone().json()).message.messageId;
    const stop = await predecessorStop;
    // The reborn is visible as soon as it is accepted: it waits on the stop,
    // bound to the exact mention, before any successor Run exists.
    const rebornStatus = async () => (await (await worker.fetch(
      `/api/channels/${encodeURIComponent(channel.id)}/agent-launches/query`, { method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ sourceMessageIds: [rebornMessageId] }) })).json()).continuations ?? [];
    const accepted = await rebornStatus();
    assert.equal(accepted.length, 1, JSON.stringify(accepted));
    assert.equal(accepted[0].kind, "reborn");
    assert.equal(accepted[0].sourceMention, `@eevee:${ordinal}:reborn`);
    assert.equal(accepted[0].reborn.state, "waiting");
    assert.equal(accepted[0].activity, undefined);
    assert.equal(stop.agentId, command.instanceId, "a registered predecessor is stopped as its Instance");
    const resumedSpawn = daemon.inbox.waitFor(message => message.type === "machine_spawn_agent"
      && message.channelId === channel.id && message.resume === true, "registered reborn spawn");
    // Stopping kills the Agent process before the daemon reports the stop.
    agent.ws.close();
    agent = undefined;
    await new Promise(resolve => setTimeout(resolve, 500));
    sendStopResult(daemon, stop, { ok: true, pid: 4242 });
    const resumed = await resumedSpawn;
    assert.equal(resumed.context?.requestedModel, undefined, 'reborn preserves runtime defaults');
    assert.equal(resumed.context?.requestedEffort, undefined);
    assert.equal(resumed.instanceId, command.instanceId);
    assert.equal(resumed.identityId, command.instanceId);
    assert.equal(resumed.resumeSessionKey, command.resumeSessionKey);
    assert.deepEqual(resumed.registration.key, command.registration.key);
    assert.equal(resumed.registration.instanceId, command.instanceId);
    assert.notEqual(resumed.runId, command.runId);

    // The successor has no Launch row. It is still admitted by the same
    // lease-proving preflight, and the resumed Agent reconnects as its Instance.
    assert.equal(resumed.launchId, undefined, "a reborn successor carries no Launch");
    const resumedToken = await admitRegisteredSpawn(worker, daemon, resumed);
    agent = await connectAgent(worker, runAgentConnection(resumed, channel.id, run), resumedToken);
    const rejoined = await agent.request({ type: "join_channel", channelId: channel.id, historyLimit: 0 });
    assert.equal(rejoined.type, "channel_joined", JSON.stringify(rejoined));
    // The same record now carries the successor Run's startup.
    const resumedStatus = await rebornStatus();
    assert.equal(resumedStatus.length, 1, JSON.stringify(resumedStatus));
    assert.equal(resumedStatus[0].runId, resumed.runId);
    assert.ok(resumedStatus[0].activity, JSON.stringify(resumedStatus[0]));
  } finally {
    agent?.ws?.close();
    daemon?.ws?.close();
    await worker.stop();
  }
});
