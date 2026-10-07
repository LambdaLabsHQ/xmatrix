import assert from "node:assert/strict";
import test from "node:test";
import {
  admitRegisteredSpawn, connectAgent, createRoutableAgent, homeSpaceId, inTestTransaction, json, MOCK_TOKEN, randomUUID,
  REGISTERED_DAEMON_CAPABILITIES, sendSpawnResult, startPgHubWorker,
} from "./agent-launch-postgres.fixture.mjs";
import { channelHistory, sleep, waitForChannelHistoryMessage } from "./agent-mention-spawn.fixture.mjs";
import { githubAppPrivateKey, githubInstallationCatalog, grantRegistrationRepository } from "./registration-launch.fixture.mjs";

/**
 * docs/same-machine-instance-handoff.md §2.1–2.2, end to end against a local
 * Hub on PostgreSQL: a repository-backed claude Instance on machine A runs out
 * of provider usage. xMatrix only posts `@claude:<n>:handoff:@auto`; that
 * ordinary handoff finds nobody else on A, so A's daemon is asked to stop the
 * source and push its whole checkout to a handoff branch, and a codex Instance
 * starts on machine B, told to continue from that branch. Nothing else is said.
 */

const repository = "LambdaLabsHQ/xmatrix";
const installationId = "fixture-installation";
const machineA = "machine:3ff42ec94ea778fdf762ad6636c0d11e4a418159353c602f01246d03e2a2cc30";
const machineB = "machine:f890666a197ae125abd20d6cc0bc9f25de8579263943285e87819c555221a2e6";
const capabilities = [...REGISTERED_DAEMON_CAPABILITIES, "machine_handoff_export_v1"];

/**
 * Run claude on machine A until its provider account runs out; `answerStop`
 * plays machine A's daemon answering the handoff stop. Returns what the
 * Channel and machine B saw.
 */
async function usageLimitedOnMachineA(answerStop, { sleeping = false } = {}) {
  const userId = `cross-machine-handoff-${randomUUID()}`;
  const github = await githubInstallationCatalog(installationId, [{
    id: 1, name: "xmatrix", full_name: repository, private: true, archived: false,
    pushed_at: "2026-09-01T00:00:00Z", owner: { login: "LambdaLabsHQ" },
  }]);
  let worker, daemonA, daemonB, source, successorAgent;
  try {
    worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      GITHUB_API_BASE_URL: github.url, GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: await githubAppPrivateKey(),
      // The bundled local routing decision answers every question; the key only enables the path.
      JEV_AI_GATEWAY_API_KEY: "local-routing-decision",
      XMATRIX_MOCK_AUTH_USER_ID: userId, XMATRIX_MOCK_AUTH_EMAIL: "cross-machine-handoff@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Cross Machine Handoff" } });
    const headers = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const spaceId = await homeSpaceId(worker);
    const { channel } = await json(await worker.fetch("/api/channels", { method: "POST", headers,
      body: JSON.stringify({ spaceId, mode: "closed", name: `cross-machine-handoff-${randomUUID()}`, access: [] }) }));
    const hostA = `handoff-host-a-${randomUUID()}`, hostB = `handoff-host-b-${randomUUID()}`;
    const daemon = (machineId, hostId) => connectAgent(worker, { name: `xmatrix-daemon-${hostId}`, agentType: "xmatrix_daemon",
      metadata: { kind: "daemon", machineId, hostId, hostName: hostId, capabilities } });
    daemonA = await daemon(machineA, hostA);
    daemonB = await daemon(machineB, hostB);
    const claude = await createRoutableAgent(worker, { token: MOCK_TOKEN, spaceId, name: "claude", harness: "claude",
      machineId: machineA, hostId: hostA });
    const codex = await createRoutableAgent(worker, { token: MOCK_TOKEN, spaceId, name: "codex", harness: "codex",
      machineId: machineB, hostId: hostB });
    for (const { key } of [claude, codex]) {
      await grantRegistrationRepository(worker, { token: MOCK_TOKEN, key, repository, installationId });
    }

    // claude starts on machine A in a checkout of the repository.
    const spawnA = daemonA.inbox.waitFor(message => message.type === "machine_spawn_agent" && message.channelId === channel.id,
      "claude spawn on machine A");
    const summon = await worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/messages`, { method: "POST", headers,
      body: JSON.stringify({ body: `@auto repo:${repository} machine:${machineA} fix the bug` }) });
    assert.equal(summon.status, 200, await summon.clone().text());
    const launch = await spawnA;
    assert.equal(launch.remoteRepo, repository);
    assert.equal(launch.registration.key.harness, "claude");
    const token = await admitRegisteredSpawn(worker, daemonA, launch);
    if (sleeping) sendSpawnResult(daemonA, launch, { ok: true, pid: 4242 });
    source = await connectAgent(worker, { identityId: launch.instanceId, name: launch.agentName, agentType: "claude",
      metadata: { tool: "claude", machineId: machineA, hostId: hostA, workspaceMachineId: machineA,
        workspaceCwd: launch.workspace.canonicalCwd, cwd: launch.workspace.canonicalCwd,
        runId: launch.runId, executionKey: launch.executionKey, autoJoinChannelId: channel.id } }, token);
    assert.equal((await source.request({ type: "join_channel", channelId: channel.id, historyLimit: 0 })).type, "channel_joined");

    // A sleeping source has no active Run: the old handoff implementation
    // omitted it from stop targets, then the successor's reply woke it again.
    if (sleeping) {
      daemonA.ws.send(JSON.stringify({ type: "machine_run_exited", runId: launch.runId,
        executionKey: launch.executionKey, agentId: launch.instanceId, agentName: launch.agentName,
        pid: 4242, status: "exit status: 0", exitCode: 0, completed: false, delivered: false, restReason: "sleeping" }));
      let resting;
      for (let attempt = 0; attempt < 100; attempt++) {
        [resting] = await inTestTransaction(tx => tx.query({
          text: "SELECT status,rest_state,channel_instance_id FROM data.instances WHERE instance_id=$1",
          values: [launch.instanceId] }));
        if (resting.status === "offline" && resting.rest_state === "sleeping") break;
        await sleep(25);
      }
      assert.equal(resting.rest_state, "sleeping", JSON.stringify(resting));
      source.ws.close();
      const response = await worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/messages`, {
        method: "POST", headers, body: JSON.stringify({ body: `@claude:${resting.channel_instance_id}:handoff:@auto` }) });
      assert.equal(response.status, 200, await response.clone().text());
    }

    // Its provider account runs out, or the owner hands off its sleeping work.
    const stopA = daemonA.inbox.waitFor(message => message.type === "machine_stop_agent" && message.runId === launch.runId,
      "handoff stop on machine A", 30_000);
    if (!sleeping) source.ws.send(JSON.stringify({ type: "agent_lifecycle", channelId: channel.id, layer: "application",
      status: "failed", reason: "usage_limited", detail: "You've hit your session limit · resets 10:20am (UTC)",
      resetsAt: new Date(Date.now() + 3_600_000).toISOString() }));

    // The Channel gets the handoff itself, and nothing else.
    const handoff = await waitForChannelHistoryMessage(worker, MOCK_TOKEN, channel.id,
      message => /^@claude:\d+:handoff:@auto$/u.test(message.body ?? ""), "handoff message", 30_000);
    // Short ASCII ids: live delivery caps a message id at 160 characters.
    if (!sleeping) assert.match(handoff.messageId, /^system:usage-limit-handoff:[0-9a-f]{32}$/u);

    // Machine A is asked to stop the source and push its checkout, keeping it.
    const stop = await stopA;
    assert.equal(stop.worktreeDisposition, "retain");
    assert.match(stop.handoffExport.branch, /^xmatrix\/handoff\/[0-9a-f]{16}$/u);
    assert.equal(stop.handoffExport.channelId, channel.id);
    const spawnB = daemonB.inbox.waitFor(message => message.type === "machine_spawn_agent" && message.channelId === channel.id,
      "codex spawn on machine B", 30_000);
    daemonA.ws.send(JSON.stringify({ type: "machine_stop_result", requestId: stop.requestId, runId: stop.runId,
      executionKey: stop.executionKey, agentId: stop.agentId, instanceId: stop.instanceId,
      worktreeDisposition: stop.worktreeDisposition, ok: true, pid: 4242, cleanupReason: "process_terminated",
      ...answerStop(stop), relayLease: stop.relayLease }));

    // codex starts on machine B.
    const successor = await spawnB;
    assert.equal(successor.registration.key.machineId, machineB);
    assert.equal(successor.registration.key.harness, "codex");
    assert.equal(successor.remoteRepo, repository);
    assert.match(successor.prompt, /@claude:\d+ handed its work to you/);

    if (sleeping) {
      const successorToken = await admitRegisteredSpawn(worker, daemonB, successor);
      sendSpawnResult(daemonB, successor, { ok: true, pid: 5252 });
      successorAgent = await connectAgent(worker, { identityId: successor.instanceId, name: successor.agentName,
        agentType: "codex", metadata: { tool: "codex", machineId: machineB, hostId: hostB,
          workspaceMachineId: machineB, workspaceCwd: successor.workspace.canonicalCwd,
          cwd: successor.workspace.canonicalCwd, runId: successor.runId, executionKey: successor.executionKey,
          autoJoinChannelId: channel.id } }, successorToken);
      await successorAgent.request({ type: "join_channel", channelId: channel.id, historyLimit: 0 });
      const reply = await successorAgent.request({ type: "channel_message", channelId: channel.id,
        body: "I have taken over the sleeping source's work." });
      assert.equal(reply.type, "channel_message_dispatched", JSON.stringify(reply));
      await sleep(500);
      const [previous] = await inTestTransaction(tx => tx.query({
        text: "SELECT run_id,rest_state FROM data.instances WHERE instance_id=$1", values: [launch.instanceId] }));
      assert.equal(previous.run_id, launch.runId, "the source must not resume into a new Run");
      assert.equal(previous.rest_state, "stopped");
      const intents = await inTestTransaction(tx => tx.query({ text: `SELECT intent_id
        FROM data.agent_reborn_intents WHERE source_instance_id=$1 AND kind='wake'`, values: [launch.instanceId] }));
      assert.equal(intents.length, 0, "the successor's reply must not prepare a source wake");
    }

    // A handoff that went through says nothing more.
    const history = await channelHistory(worker, MOCK_TOKEN, channel.id);
    assert.equal(history.messages.filter(message => /could not hand off/u.test(message.body ?? "")).length, 0);
    assert.equal(history.messages.filter(message => /:handoff:@auto/u.test(message.body ?? "")).length, 1);
    return { branch: stop.handoffExport.branch, successor };
  } finally {
    successorAgent?.ws?.close();
    source?.ws?.close();
    daemonA?.ws?.close();
    daemonB?.ws?.close();
    await worker?.stop();
    await github.close();
  }
}

test("a usage-limited Instance's checkout moves to another machine through one handoff:@auto", async () => {
  const commit = "d".repeat(40);
  const { branch, successor } = await usageLimitedOnMachineA(stop => ({
    handoffExport: { branch: stop.handoffExport.branch, state: "pushed", commit, base: "e".repeat(40), dirty: true } }));
  assert.ok(successor.prompt.includes(`git fetch origin ${branch} && git checkout --detach FETCH_HEAD`), successor.prompt);
  assert.match(successor.prompt, /including uncommitted and untracked work/);
  assert.match(successor.prompt, /retry for a few minutes/);
});

test("a machine whose daemon predates exports still hands off with branch retries and recovery instructions", async () => {
  const { branch, successor } = await usageLimitedOnMachineA(() => ({}));
  assert.ok(successor.prompt.includes(`git fetch origin ${branch} && git checkout --detach FETCH_HEAD`));
  assert.match(successor.prompt, /If the branch never appears, its directory remains on its machine/);
});

test("handing off a sleeping source stops it before the successor's reply can wake it", async () => {
  await usageLimitedOnMachineA(() => ({}), { sleeping: true });
});
