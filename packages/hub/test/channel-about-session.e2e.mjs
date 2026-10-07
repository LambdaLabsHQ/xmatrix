import {
  assert,
  channelHistory,
  connectAgent,
  json,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  sleep,
  test,
} from "./agent-mention-spawn.fixture.mjs";
import { admitRegisteredSpawn, connectDaemon, createClosedChannel, createRoutableAgent, enableManagementAgent, sendSpawnResult, startPgHubWorker, testMachine, homeSpaceId } from "./agent-launch-postgres.fixture.mjs";
import { Client } from "pg";

async function channelRowCount(connectionString, channelId) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query("SELECT count(*)::integer AS count FROM data.channels WHERE channel_id=$1",
      [channelId]);
    return result.rows[0].count;
  } finally { await client.end(); }
}

// Every worker runs the singleton Launch coordinator, which claims every
// eligible Launch in its database. Sharing one database let a concurrent
// test's coordinator claim this suite's fresh management Launch, settle it
// daemon-offline (its daemon socket lives in the other worker) and defer it
// 30s, so the management spawn below timed out.
test("concurrent PostgreSQL test workers never share the database their Launch coordinators claim from", async () => {
  const userId = `pg-worker-isolation-e2e-${randomUUID()}`;
  const vars = { XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "pg-worker-isolation-e2e@example.com", XMATRIX_MOCK_AUTH_NAME: "PG Worker Isolation" };
  const [first, second] = await Promise.all([startPgHubWorker({ vars }), startPgHubWorker({ vars })]);
  try {
    assert.notEqual(first.postgresUrl, second.postgresUrl);
    const created = await json(await first.fetch("/api/channels", {
      method: "POST",
      headers: { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ spaceId: await homeSpaceId(first), mode: "closed", name: `pg-worker-isolation-${randomUUID()}`, access: [] }),
    }));
    assert.equal(await channelRowCount(first.postgresUrl, created.channel.id), 1);
    assert.equal(await channelRowCount(second.postgresUrl, created.channel.id), 0);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("channel activity starts an implicit About session without posting a request message", async () => {
  const userId = `channel-about-e2e-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "channel-about-e2e@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Channel About E2E",
    },
  });
  let daemon;
  let managementAgent;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const { hostId, machineId } = testMachine("channel-about");
    const root = await createClosedChannel(worker, `channel-about-root-${randomUUID()}`);
    const languageConfigured = await worker.fetch(`/api/spaces/${encodeURIComponent(root.spaceId)}`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        metadata: {
          locale: { defaultLocale: "zh-CN", supportedLocales: ["zh-CN", "en"] },
          preferredLanguage: "zh",
        },
      }),
    });
    assert.equal(languageConfigured.status, 200, await languageConfigured.clone().text());

    daemon = await connectDaemon(worker, { machineId, hostId });
    // Channel About launches through registrations: Jev chooses among them.
    await createRoutableAgent(worker, { token: MOCK_TOKEN, spaceId: root.spaceId,
      name: `channel-about-manager-${randomUUID()}`, machineId, hostId, capabilities: ["maintenance"] });
    const configured = await enableManagementAgent(worker, root.spaceId);
    assert.equal(configured.status, 200, await configured.clone().text());

    const managerSpawn = daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" &&
        message.channelId === root.id && message.registration !== undefined,
      "implicit channel About management agent spawn",
    );
    const evidenceMessages = [];
    for (let index = 1; index <= 5; index += 1) {
      const posted = await postChannelMessage(
        worker,
        MOCK_TOKEN,
        root.id,
        `Channel About evidence ${index}`,
      );
      evidenceMessages.push(posted.message);
    }

    const managementCommand = await managerSpawn;
    assert.equal(managementCommand.sourceMessageId, undefined, "About organization has no synthetic message");
    assert.match(managementCommand.prompt, /implicit system request, not a Channel message/u);
    assert.match(managementCommand.prompt, /Always recompute and apply the About/u);
    assert.match(managementCommand.prompt, /Do not post an acknowledgement, proposal, confirmation, or any other message/u);
    assert.match(managementCommand.prompt, /entirely in Simplified Chinese \(zh\)/u);
    assert.match(managementCommand.prompt, /only source of the About output language/u);

    const historyAfterTrigger = await channelHistory(worker, MOCK_TOKEN, root.id);
    assert.deepEqual(
      historyAfterTrigger.messages.map((message) => message.messageId),
      evidenceMessages.map((message) => message.messageId),
      "starting About organization must not add a visible request message",
    );

    // About binds its own Run, never a Channel Instance.
    assert.equal(managementCommand.instanceId, `${root.id}:about#1`);
    assert.equal(managementCommand.runId, managementCommand.instanceId);
    assert.equal(managementCommand.registration.instanceId, managementCommand.instanceId);
    const managementToken = await admitRegisteredSpawn(worker, daemon, managementCommand);
    sendSpawnResult(daemon, managementCommand, { ok: true, pid: 4242 });
    managementAgent = await connectAgent(worker, {
      identityId: managementCommand.identityId,
      name: managementCommand.agentName,
      agentType: "codex",
      autoProvisionRun: false,
      metadata: {
        tool: "codex",
        machineId,
        hostId,
        hostName: hostId,
        workspaceMachineId: managementCommand.workspace.machineId,
        workspaceCwd: managementCommand.workspace.canonicalCwd,
        cwd: managementCommand.workspace.canonicalCwd,
        runId: managementCommand.runId,
        executionKey: managementCommand.executionKey,
        autoJoinChannelId: root.id,
      },
    }, managementToken);
    const instances = await json(await worker.fetch("/api/agent-instances", { headers: auth }));
    assert.equal(
      instances.instances.some((instance) => instance.instanceId === managementCommand.instanceId),
      false,
      "Channel About sessions never appear as Channel Agent Instances",
    );
    const aboutHistory = await channelHistory(worker, managementToken, root.id);
    assert.equal(aboutHistory.aboutInput.expectedRevision, 0);
    const metadataBefore = await json(await worker.fetch(`/api/channels/${root.id}/metadata-history`, {
      headers: { Authorization: `Bearer ${managementToken}` },
    }));
    assert.equal(metadataBefore.currentRevision, 0);
    const catalog = await json(await worker.fetch(`/api/channels?familyOfChannelId=${root.id}`, {
      headers: { Authorization: `Bearer ${managementToken}` },
    }));
    assert.deepEqual(catalog.channels.map(channel => channel.id), [root.id]);
    assert.equal(catalog.catalogSync, undefined, "no other Channel catalog context reaches About");
    const foreign = await createClosedChannel(worker, `foreign-${randomUUID()}`);
    for (const path of [`/api/channels/${foreign.id}/history`, `/api/channels/${foreign.id}/metadata-history`,
      `/api/channels?familyOfChannelId=${foreign.id}`]) {
      const denied = await worker.fetch(path, { headers: { Authorization: `Bearer ${managementToken}` } });
      assert.ok([401,403].includes(denied.status), `${path}: ${denied.status}`);
    }
    const stale = await worker.fetch(`/api/channels/${root.id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      body: JSON.stringify({ summary: "Stale About", throughMessageId: evidenceMessages.at(-1).messageId, expectedRevision: 99 }),
    });
    assert.equal(stale.status, 409, await stale.clone().text());
    const foreignInput = await worker.fetch(`/api/channels/${root.id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      body: JSON.stringify({ summary: "Foreign input", throughMessageId: "other-channel-message", expectedRevision: 0 }),
    });
    assert.equal(foreignInput.status, 403, await foreignInput.clone().text());
    // What a Windows code-page shell leaves of that text is refused and not
    // saved; the session stays open, so the write below still succeeds.
    const mangled = await worker.fetch(`/api/channels/${encodeURIComponent(root.id)}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      body: JSON.stringify({ summary: "?????? Management Agent ???? About?", name: "????" }),
    });
    assert.equal(mangled.status, 422, await mangled.clone().text());
    assert.equal((await mangled.json()).code, "channel_about_text_mangled");
    const summary = "自动整理并验证 Management Agent 的频道 About。";
    const update = await worker.fetch(`/api/channels/${encodeURIComponent(root.id)}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      body: JSON.stringify({ summary, throughMessageId: evidenceMessages.at(-1).messageId, expectedRevision: 0 }),
    });
    assert.equal(update.status, 200, await update.clone().text());
    const updated = await json(update);
    assert.equal(updated.channel.metadata.summary, summary);
    assert.equal(updated.channel.metadata.metadataRevision, 1);
    const revisions = await json(await worker.fetch(`/api/channels/${root.id}/metadata-history`, { headers: auth }));
    assert.deepEqual(revisions.revisions.map(row => Number(row.revision)), [1,0]);
    assert.equal(revisions.revisions[0].summary, summary);
    assert.equal(revisions.revisions[0].source_json.runId, managementCommand.runId);
    assert.ok(revisions.revisions[0].source_json.inputIds.includes(aboutHistory.aboutInput.inputId));
    assert.equal(revisions.revisions[0].source_json.triggerMessageId, evidenceMessages.at(-1).messageId);
    const inputEvidence = await json(await worker.fetch(`/api/channels/${root.id}/metadata-history?inputId=${aboutHistory.aboutInput.inputId}`, { headers: auth }));
    assert.deepEqual(inputEvidence.input.references_json.map(ref => ref.messageId), aboutHistory.messages.map(message => message.messageId));
    assert.ok(inputEvidence.input.references_json[0].recordDigest);
    assert.ok(inputEvidence.input.references_json[0].payloadBundleBase64);
    const restored = await worker.fetch(`/api/channels/${root.id}/metadata-restore`, {
      method: "POST",headers: { ...auth,"content-type": "application/json" },
      body: JSON.stringify({ revision: 0, expectedRevision: 1 }),
    });
    assert.equal(restored.status, 200, await restored.clone().text());
    const restoreResult = await json(restored);
    assert.equal(restoreResult.channel.metadata.metadataRevision, 2);
    assert.equal(restoreResult.channel.metadata.summary, undefined);
    assert.equal((await json(await worker.fetch(`/api/channels/${root.id}/metadata-history?revision=1`, { headers: auth }))).revisions[0].summary, summary);
    // The Hub, not the session, records who wrote the summary and how far it read.
    assert.deepEqual(updated.channel.summarySource, {
      author: { kind: "run", runId: managementCommand.runId, agentName: managementCommand.agentName },
      generatedAt: updated.channel.summarySource.generatedAt,
      throughSequence: evidenceMessages.at(-1).sequence,
    });
    // Its one job is done, so the Hub has its daemon end it; the refresh it
    // was handed meanwhile then starts as its successor.
    const aboutStop = await daemon.inbox.waitFor(
      (message) => message.type === "machine_stop_agent" && message.runId === managementCommand.runId,
      "Channel About session stop after its summary was saved",
    );
    assert.equal(aboutStop.instanceId, managementCommand.instanceId);
    assert.equal(aboutStop.channelId, root.id);
    assert.match(updated.channel.metadata.summary, /\p{Script=Han}/u);

    const forbiddenRuntimeWrite = await managementAgent.request({
      type: "channel_message",
      channelId: root.id,
      body: "Channel About must never publish over Runtime",
    });
    assert.equal(forbiddenRuntimeWrite.type, "error");
    assert.match(forbiddenRuntimeWrite.message, /cannot write Channel messages/u);

    const forbiddenWrite = await worker.fetch(
      `/api/channels/${encodeURIComponent(root.id)}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
        body: JSON.stringify({ body: "Channel About must never post this message" }),
      },
    );
    assert.ok(
      forbiddenWrite.status === 401 || forbiddenWrite.status === 403,
      `Channel About message write returned ${forbiddenWrite.status}`,
    );

    const laterEvidenceMessages = [];
    for (let index = 6; index <= 10; index += 1) {
      const posted = await postChannelMessage(worker, MOCK_TOKEN, root.id, `Channel About evidence ${index}`);
      laterEvidenceMessages.push(posted.message);
    }
    await assert.rejects(
      daemon.inbox.waitFor(
        (message) => message.type === "machine_spawn_agent" &&
          message.channelId === root.id &&
          message.registration !== undefined &&
          message.runId !== managementCommand.runId,
        "unexpected concurrent Channel About session",
        250,
      ),
      /Timed out waiting for unexpected concurrent Channel About session/u,
      "a second cadence trigger must coalesce while About is active",
    );

    managementAgent.ws.close();
    managementAgent = undefined;
    const refreshSpawn = daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" &&
        message.channelId === root.id &&
        message.registration !== undefined &&
        message.runId !== managementCommand.runId,
      "coalesced Channel About successor",
    );
    daemon.ws.send(JSON.stringify({
      type: "machine_run_exited",
      runId: managementCommand.runId,
      instanceId: managementCommand.instanceId,
      executionKey: managementCommand.executionKey,
      agentId: managementCommand.identityId,
      agentName: managementCommand.agentName,
      pid: 4242,
      status: "completed",
      exitCode: 0,
      completed: true,
      delivered: true,
    }));
    const refreshCommand = await refreshSpawn;
    assert.equal(refreshCommand.sourceMessageId, undefined, "the successor remains an invisible system task");
    assert.match(refreshCommand.prompt, /entirely in Simplified Chinese \(zh\)/u);
    const historyAfterAgentTrigger = await channelHistory(worker, MOCK_TOKEN, root.id);
    assert.deepEqual(
      historyAfterAgentTrigger.messages.map((message) => message.messageId),
      [...evidenceMessages, ...laterEvidenceMessages].map((message) => message.messageId),
      "About writes and internal successor tasks must not mutate the timeline",
    );

    for (const command of [refreshCommand]) {
      daemon.ws.send(JSON.stringify({
        type: "machine_run_exited",
        runId: command.runId,
        executionKey: command.executionKey,
        agentId: command.identityId,
        agentName: command.agentName,
        pid: 4242,
        status: "exit code: 1",
        exitCode: 1,
        statusPhase: "wrapper_startup_failed",
        runStatusDetail: "Authority run is not live",
        completed: true,
        delivered: false,
      }));
    }
    await sleep(250);
    const historyAfterFailure = await channelHistory(worker, MOCK_TOKEN, root.id);
    assert.deepEqual(
      historyAfterFailure.messages.map((message) => message.messageId),
      [...evidenceMessages, ...laterEvidenceMessages].map((message) => message.messageId),
      "an implicit About runtime failure must not leak a visible Channel notice",
    );
  } finally {
    if (managementAgent) managementAgent.ws.close();
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});
