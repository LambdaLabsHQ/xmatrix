import {
  assert,
  connectAgent,
  connectUser,
  json,
  mintAgentRunToken,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  runAgentConnection,
  sleep,
  test,
  waitForChannelHistoryMessage,
} from "./agent-mention-spawn.fixture.mjs";
import {
  channelSpaceId, connectDaemon, createClosedChannel, createWorkspace, inTestTransaction, isSpawnOf, postAutoLaunch,
  registerTestAgent, sendSpawnResult, sendStopResult, startPgHubWorker, stopResultFor, testMachine,
} from "./agent-launch-postgres.fixture.mjs";

/** A registration's live presence in a Channel: its members are its Instances. */
/** The Agent cards a Human frame carries: one live report, or a second's digest of them. */
function presenceCards(message) {
  return message.type === "enhanced_presence" ? [message.agent]
    : message.type === "presence_digest" ? message.agents : [];
}

function registrationPresence(channel, key) {
  const members = Object.values(channel?.memberPresence ?? {}).filter(member =>
    member.registration?.ownerUserId === key.ownerUserId && member.registration.machineId === key.machineId &&
    member.registration.harness === key.harness);
  return { instances: members.flatMap(member => member.instances ?? []), usage: members[0]?.usage };
}

test("a recoverable spawn failure keeps the Run live so reconnect can mint a token", async () => {
  const userId = `daemon-recoverable-spawn-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "daemon-recoverable-spawn@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Daemon Recoverable Spawn",
    },
  });
  let firstDaemon;
  let daemon;
  try {
    const { hostId, machineId } = testMachine("recoverable");
    const channelId = (await createClosedChannel(worker, `recoverable-${randomUUID()}`)).id;
    firstDaemon = await connectDaemon(worker, { machineId, hostId });
    const canonicalCwd = `/tmp/xmatrix-recoverable-${randomUUID()}`;
    await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: "recoverable-workspace" });
    const registration = await registerTestAgent(worker, { token: MOCK_TOKEN,
      spaceId: await channelSpaceId(channelId), machineId, displayName: "codex-recoverable-spawn", canonicalCwd });
    await postAutoLaunch(worker, { channelId, machineId, canonicalCwd }, "retry after token-context mismatch");
    const firstCommand = await firstDaemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent"
        && message.channelId === channelId
        && isSpawnOf(message, registration),
      "first spawn before recoverable failure",
    );
    sendSpawnResult(firstDaemon, firstCommand, { ok: false, error: "Agent run token context does not match the live Authority run" });
    await sleep(200);
    firstDaemon.ws.close();
    await sleep(100);
    daemon = await connectDaemon(worker, { machineId, hostId });
    const retryCommand = await daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent"
        && message.runId === firstCommand.runId
        && message.channelId === channelId,
      "reclaimed spawn after recoverable failure",
    );
    assert.notEqual(retryCommand.requestId, firstCommand.requestId,
      "a retry is a new spawn command; the failed one already completed");
    const runToken = await mintAgentRunToken(worker, daemon, retryCommand, channelId);
    assert.equal(typeof runToken, "string");
    assert.ok(runToken.length > 0);
  } finally {
    if (daemon) daemon.ws.close();
    if (firstDaemon) firstDaemon.ws.close();
    await worker.stop();
  }
});

test("a complete daemon snapshot ends the absent Run and keeps its Instance recoverable", async () => {
  const userId = `daemon-snapshot-reconcile-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "daemon-snapshot-reconcile@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Daemon Snapshot Reconcile E2E",
    },
  });
  let daemon;
  let oldAgent;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const { hostId, machineId } = testMachine("snapshot");
    const channelId = (await createClosedChannel(worker, `snapshot-${randomUUID()}`)).id;
    daemon = await connectDaemon(worker, { machineId, hostId });
    const canonicalCwd = `/tmp/xmatrix-snapshot-${randomUUID()}`;
    await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: "snapshot-workspace" });

    const registration = await registerTestAgent(worker, { token: MOCK_TOKEN,
      spaceId: await channelSpaceId(channelId), machineId, displayName: "codex-snapshot-reconcile", canonicalCwd });
    await postAutoLaunch(worker, { channelId, machineId, canonicalCwd }, "first run");
    const first = await daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" && message.channelId === channelId,
      "first snapshot-reconciled spawn",
    );
    daemon.ws.send(JSON.stringify({
      type: "machine_run_snapshot",
      snapshotComplete: true,
      runs: [],
    }));
    await sleep(50);
    // A starting Run is still a queued/in-flight spawn, not daemon-owned
    // absence evidence. The spawn acknowledgement must remain admissible even
    // if a reconnect snapshot was captured before local registry admission.
    sendSpawnResult(daemon, first, { instanceId: undefined, ok: true, pid: 4242 });
    await sleep(50);
    const firstToken = await mintAgentRunToken(worker, daemon, first, channelId);
    const oldConnection = runAgentConnection(first, channelId, { machineId, hostId });
    oldAgent = await connectAgent(worker, oldConnection, firstToken);
    const oldInstanceId = oldAgent.agent.instanceId || oldAgent.agent.id;
    oldAgent.ws.close();
    oldAgent = undefined;
    let closed = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const catalog = await json(await worker.fetch("/api/channels", { headers: auth }));
      const current = catalog.channels.find((candidate) => candidate.id === channelId);
      const instances = registrationPresence(current, registration).instances || [];
      if (!instances.some((instance) => instance.id === oldInstanceId)) {
        closed = true;
        break;
      }
      await sleep(20);
    }
    assert.equal(closed, true, "transport close must drop catalog Online presence");

    daemon.ws.send(JSON.stringify({
      type: "machine_run_snapshot",
      snapshotComplete: false,
      runs: [],
    }));
    await sleep(50);
    const incompleteCatalog = await json(await worker.fetch("/api/channels", { headers: auth }));
    const incompleteChannel = incompleteCatalog.channels.find((candidate) => candidate.id === channelId);
    const incompleteInstances = registrationPresence(incompleteChannel, registration).instances || [];
    assert.equal(
      incompleteInstances.some((instance) => instance.id === oldInstanceId),
      false,
      "an incomplete snapshot must not resurrect a closed host",
    );

    daemon.ws.send(JSON.stringify({
      type: "machine_run_snapshot",
      snapshotComplete: true,
      runs: [],
    }));
    // A completed snapshot ends the absent Run but keeps its Instance visible
    // as offline/interrupted. Requiring total absence only passed when the
    // catalog read raced ahead of the transaction observed by the following SQL.
    let retired = false;
    let lastState = {};
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const catalog = await json(await worker.fetch("/api/channels", { headers: auth }));
      const current = catalog.channels.find((candidate) => candidate.id === channelId);
      const instances = registrationPresence(current, registration).instances || [];
      const [run] = await inTestTransaction(tx => tx.query({
        text: "SELECT status FROM data.runs WHERE run_id=$1", values: [first.runId] }));
      const resting = instances.find((instance) => instance.id === oldInstanceId);
      lastState = { runStatus: run?.status, instanceStatus: resting?.status, rest: resting?.rest };
      if (run?.status === "exited" && resting?.status === "offline" && resting.rest === "interrupted") {
        retired = true;
        break;
      }
      await sleep(20);
    }
    assert.equal(retired, true, `snapshot must end the Run and retain an offline/interrupted Instance: ${JSON.stringify(lastState)}`);
    await assert.rejects(
      connectAgent(worker, oldConnection, firstToken),
      error => error.failure?.code === "agent_run_not_live",
    );

    await postAutoLaunch(worker, { channelId, machineId, canonicalCwd }, "fresh run");
    const fresh = await daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" && message.channelId === channelId &&
        message.runId !== first.runId && message.identityId !== first.identityId,
      "fresh spawn after snapshot reconciliation",
    );
    assert.notEqual(fresh.runId, first.runId);
    // @auto selects its own new Run; resting observers must stay asleep.
    await assert.rejects(daemon.inbox.waitFor(
      message => message.type === "machine_spawn_agent" && message.identityId === first.identityId,
      "unexpected observer wake from @auto", 500,
    ), /Timed out/);
    // Ordinary human work can still resume the interrupted Instance.
    assert.equal((await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: "Continue the interrupted work" }),
    })).status, 200);
    const wake = await daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" && message.channelId === channelId &&
        message.identityId === first.identityId && message.resume === true,
      "wake of the interrupted Instance",
    );
    assert.equal(wake.resumeInstanceId, first.identityId);
    assert.equal(typeof wake.sourceMessageId, "string", "the waking message is the woken Instance's first prompt");
    assert.match(wake.prompt, /Continue the interrupted work/u);
    const freshToken = await mintAgentRunToken(worker, daemon, fresh, channelId);
    const freshAgent = await connectAgent(worker, runAgentConnection(fresh, channelId, { machineId, hostId }), freshToken);
    assert.notEqual(freshAgent.agent.instanceId || freshAgent.agent.id, oldInstanceId);
    freshAgent.ws.close();
  } finally {
    if (oldAgent) oldAgent.ws.close();
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});

test("a historical instance reborn mention reuses its durable session key after host restart", async () => {
  const userId = `daemon-reborn-e2e-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "daemon-reborn-e2e@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Daemon Reborn E2E",
    },
  });
  let daemon;
  let agent;
  let human;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const { hostId, machineId } = testMachine("workstation");
    const channelId = (await createClosedChannel(worker, `reborn-${randomUUID()}`)).id;
    daemon = await connectDaemon(worker, { machineId, hostId });
    const canonicalCwd = `/tmp/xmatrix-reborn-${randomUUID()}`;
    await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: "reborn-workspace" });

    const registration = await registerTestAgent(worker, { token: MOCK_TOKEN,
      spaceId: await channelSpaceId(channelId), machineId, displayName: "codex-reborn-route", canonicalCwd });
    await postAutoLaunch(worker, { channelId, machineId, canonicalCwd }, "preserve this session");
    const first = await daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" && message.channelId === channelId &&
        isSpawnOf(message, registration),
      "initial machine spawn",
    );
    assert.equal(typeof first.resumeSessionKey, "string");
    assert.equal(first.resumeWorktreeBootstrap, undefined);
    // The daemon admits a registered spawn before it starts the Instance.
    await mintAgentRunToken(worker, daemon, first, channelId);
    sendSpawnResult(daemon, first, { ok: true, pid: 4241 });
    await sleep(300);

    const reborn = await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: "@codex-reborn-route:1:reborn continue after restart" }),
    });
    assert.equal(reborn.status, 200);
    const predecessorStop = await daemon.inbox.waitFor(
      (message) => message.type === "machine_stop_agent" && message.runId === first.runId,
      "reborn predecessor stop",
    );
    assert.equal(typeof predecessorStop.instanceId, "string");
    assert.equal(predecessorStop.preserveInstanceForReborn, true);
    // The retained stop result echoes the exact retain/session target it was issued.
    sendStopResult(daemon, predecessorStop, { ok: true, pid: 4242 });
    const resumed = await daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" && message.channelId === channelId &&
        isSpawnOf(message, registration) && message.resume === true,
      "reborn machine spawn",
    );
    assert.ok(predecessorStop.requestId < resumed.requestId, "reborn stop control sorts before spawn");
    assert.equal(resumed.resumeSessionKey, first.resumeSessionKey);
    assert.equal(resumed.resumeWorktreeBootstrap, true);
    assert.equal(typeof resumed.resumeInstanceId, "string");

    const runToken = await mintAgentRunToken(worker, daemon, resumed, channelId);
    human = await connectUser(worker);
    agent = await connectAgent(worker, {
      identityId: resumed.identityId,
      name: resumed.agentName,
      agentType: "codex",
      clientVersion: "0.16.698",
      capabilities: ["chat", "tools"],
      metadata: {
        tool: "codex",
        machineId,
        hostId,
        workspaceMachineId: resumed.workspace.machineId,
        workspaceCwd: resumed.workspace.canonicalCwd,
        workspaceName: resumed.workspace.displayName,
        cwd: resumed.workspace.canonicalCwd,
        runId: resumed.runId,
        executionKey: resumed.executionKey,
        autoJoinChannelId: channelId,
        runWorktreeBaseRef: "reused",
      },
    }, runToken);
    const presentation = {
      type: "presence_update",
      status: "busy",
      activity: "Validating safe Reborn migration",
      files: ["packages/hub/src/runtime-transport/agent-presence-snapshot.ts"],
      intent: "Restore every Agent indicator",
      gitBranch: "fix/reborn-preserve-agent-presentation",
      runtimeState: {
        status: "running",
        source: "codex_app_server",
        activeChannelId: channelId,
      },
      capabilities: ["chat", "tools"],
      goal: {
        active: true,
        objective: "Verify safe Reborn migration",
        status: "active",
        tokensUsed: 180,
      },
      model: "gpt-5.6-sol",
      models: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6",
        supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }],
      }],
      effort: "xhigh",
      commands: [{
        token: "/model",
        label: "Model",
        mode: "typed",
        argumentSource: "agent-models",
      }],
      statusChips: [
        { id: "model", label: "Model", value: "gpt-5.6-sol", source: "codex" },
      ],
      usage: {
        inputTokens: 150,
        outputTokens: 30,
        totalTokens: 180,
        contextUsedTokens: 180,
        contextWindowTokens: 1_000,
        quotaSource: "provider_api",
        quotaObservedAt: new Date().toISOString(),
        quotaUsages: [{
          label: "5h",
          window: "5h",
          used: 30,
          limit: 100,
          remaining: 70,
          percent: 30,
        }],
      },
    };
    agent.ws.send(JSON.stringify(presentation));
    // A status report reaches viewers as the Agent's card, which the client patches its Channel from.
    const reported = (instance) => instance.id === resumed.resumeInstanceId && instance.channelId === channelId &&
      instance.model === "gpt-5.6-sol" && instance.effort === "xhigh";
    const liveUpdate = await human.inbox.waitFor(
      (message) => presenceCards(message).some((card) => card.instances?.some(reported)),
      "reborn presentation update",
    );
    const liveInstance = presenceCards(liveUpdate).flatMap((card) => card.instances ?? []).find(reported);
    assert.equal(liveInstance.usage.quotaUsages[0].percent, 30);

    // A newly opened app must receive the already-live Agent presentation on
    // its first verified focus, without waiting for another Agent heartbeat.
    human.ws.close();
    human = await connectUser(worker);
    human.ws.send(JSON.stringify({
      type: "user_focus_channel",
      requestId: `initial-focus:${channelId}`,
      channelId,
      historyLimit: 1,
    }));
    const initialFocusPresence = await human.inbox.waitFor(
      (message) => message.type === "channel_updated" &&
        message.channel?.id === channelId &&
        registrationPresence(message.channel, registration).instances.some(
          (instance) => instance.id === resumed.resumeInstanceId &&
            instance.usage?.quotaUsages?.[0]?.percent === 30 &&
            instance.model === "gpt-5.6-sol",
        ),
      "initial focused-channel Agent presentation",
    );
    const initialInstance = registrationPresence(initialFocusPresence.channel, registration).instances.find(
      (instance) => instance.id === resumed.resumeInstanceId,
    );
    assert.equal(initialInstance.usage.quotaUsages[0].percent, 30);
    assert.equal(initialInstance.model, "gpt-5.6-sol");
    assert.equal(initialInstance.effort, "xhigh");
    assert.equal(initialInstance.gitBranch, "fix/reborn-preserve-agent-presentation");
    assert.equal(initialInstance.goal.objective, "Verify safe Reborn migration");
    assert.equal(initialInstance.models[0].displayName, "GPT-5.6");
    assert.equal(initialInstance.commands[0].token, "/model");
    assert.equal(initialInstance.statusChips[1].value, "xhigh");
    assert.equal(initialInstance.usage.quotaObservedAt, presentation.usage.quotaObservedAt);
    const sharedQuota = await inTestTransaction(tx => tx.query({
      text: "SELECT remaining,observed_at FROM control.registration_quota_observations WHERE owner_user_id=$1",
      values: [registration.ownerUserId],
    }));
    assert.equal(sharedQuota.length, 1, "the Instance writes one authoritative registration reading");
    assert.equal(Number(sharedQuota[0].remaining), 70);

    const catalog = await json(await worker.fetch("/api/channels", { headers: auth }));
    const restoredChannel = catalog.channels.find((candidate) => candidate.id === channelId);
    const restoredPresence = registrationPresence(restoredChannel, registration);
    const restoredInstance = restoredPresence.instances.find(
      (instance) => instance.id === resumed.resumeInstanceId,
    );
    // GET /api/channels is the Postgres projection. Branch, goal, model catalog,
    // and commands stay on the live frame. Quota percent is the registration reading.
    assert.equal(restoredPresence.usage.totalTokens, 180);
    assert.equal(restoredInstance.model, "gpt-5.6-sol");
    assert.equal(restoredInstance.effort, "xhigh");
    assert.equal(restoredInstance.statusChips[1].value, "xhigh");
    assert.equal(restoredInstance.usage.totalTokens, 180);
    assert.equal(restoredInstance.usage.quotaUsages[0].label, "5h");
    assert.equal(restoredInstance.usage.quotaUsages[0].percent, 30);
    assert.equal(restoredInstance.gitBranch, undefined);
    assert.equal(restoredInstance.goal, undefined);
    assert.equal(restoredInstance.models, undefined);
    assert.equal(restoredInstance.commands, undefined);

    const clientMessageId = randomUUID();
    const body = "Reborn presentation restored through the real Agent HTTP sender.";
    const sent = await postChannelMessage(
      worker,
      runToken,
      channelId,
      body,
      { clientMessageId },
    );
    assert.equal(sent.message.from.instanceId, resumed.resumeInstanceId);
    assert.equal(sent.message.from.channelInstanceId, "1");
    assert.equal(sent.message.from.gitBranch, "fix/reborn-preserve-agent-presentation");
    assert.equal(sent.message.from.model, "gpt-5.6-sol");
    assert.equal(sent.message.from.effort, "xhigh");
    assert.equal(sent.message.from.statusChips[0].value, "gpt-5.6-sol");

    agent.ws.send(JSON.stringify({
      ...presentation,
      model: "gpt-5.7",
      statusChips: [
        { id: "model", label: "Model", value: "gpt-5.7", source: "codex" },
      ],
    }));
    await human.inbox.waitFor(
      (message) => presenceCards(message).some((card) => card.instances?.some(
        (instance) => instance.id === resumed.resumeInstanceId && instance.model === "gpt-5.7",
      )),
      "advanced reborn presentation",
    );
    const retried = await postChannelMessage(
      worker,
      runToken,
      channelId,
      body,
      { clientMessageId },
    );
    assert.equal(retried.message.from.model, "gpt-5.6-sol");
    const historical = await waitForChannelHistoryMessage(
      worker,
      MOCK_TOKEN,
      channelId,
      (message) => message.messageId === clientMessageId,
      "reborn Agent HTTP message",
    );
    assert.equal(historical.from.model, "gpt-5.6-sol");
    assert.equal(historical.from.effort, "xhigh");
    assert.equal(historical.from.statusChips[1].value, "xhigh");

    daemon.ws.close();
    daemon = undefined;
    const stopMessage = await postChannelMessage(
      worker,
      MOCK_TOKEN,
      channelId,
      "@codex-reborn-route:1:stop",
    );
    assert.equal(stopMessage.message.body, "@codex-reborn-route:1:stop");
    await waitForChannelHistoryMessage(
      worker,
      MOCK_TOKEN,
      channelId,
      // The stop message fences the Run in its own append, so the Channel is
      // told at once. The daemon is offline, so it is told the stop is queued,
      // never that it happened; the host's termination is reported below.
      (message) => message.body === "Stop queued for @codex-reborn-route:1. Its machine's daemon is offline, " +
        "so the process keeps running until the daemon reconnects and applies the stop.",
      "message-driven stop confirmation",
    );

    // The reborn predecessor stop earlier in this test must not have produced a
    // terminal stop notice: it feeds the reborn flow, not chat feedback.
    const preResultHistory = await json(await worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/history?limit=50`,
      { headers: auth },
    ));
    assert.ok(
      !(preResultHistory.messages || []).some(
        (message) => typeof message.body === "string" && message.body.startsWith("Stopped @codex-reborn-route on "),
      ),
      "no host-confirmed stop notice may exist before the daemon confirms the stop",
    );
    const pendingStopCatalog = await json(await worker.fetch("/api/channels", { headers: auth }));
    const pendingStopChannel = pendingStopCatalog.channels.find((candidate) => candidate.id === channelId);
    assert.ok(
      registrationPresence(pendingStopChannel, registration).instances?.some(
        // Its daemon is disconnected here, so the live Instance is projected
        // machine-offline; it must still be shown, not hidden by the stop.
        (instance) => instance.id === resumed.resumeInstanceId &&
          (instance.status !== "offline" || instance.offlineReason === "machine_offline"),
      ),
      "queuing a stop must not hide a still-live Agent Instance before the daemon confirms it",
    );

    daemon = await connectDaemon(worker, { machineId, hostId });
    const stopCommand = await daemon.inbox.waitFor(
      (message) => message.type === "machine_stop_agent" && message.runId === resumed.runId,
      "queued stop after daemon reconnect",
    );
    assert.equal(stopCommand.instanceId, resumed.resumeInstanceId);
    assert.equal(stopCommand.reason, "Stopped from xMatrix web");

    const stopResult = await worker.fetch("/api/daemon/control-result", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemon.machineCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(stopResultFor(stopCommand, { ok: true, cleanupReason: "already_absent" })),
    });
    assert.equal(stopResult.status, 200, await stopResult.text());
    const deadline = Date.now() + 15_000;
    let confirmed;
    while (Date.now() < deadline) {
      const page = await json(await worker.fetch(
        `/api/channels/${encodeURIComponent(channelId)}/agent-launches/query`,
        { method: "POST", headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ sourceMessageIds: [stopMessage.message.messageId] }) },
      ));
      confirmed = (page.stops || []).find((stop) => stop.runId === resumed.runId);
      if (confirmed?.phase === "confirmed") break;
      await sleep(25);
    }
    assert.equal(confirmed?.phase, "confirmed", "the command's receipt is the Workstation confirmation");
    const history = await json(await worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/history?limit=50`,
      { headers: auth },
    ));
    assert.ok(
      !(history.messages || []).some(
        (message) => typeof message.body === "string" &&
          (message.body.includes("process tree is terminated") ||
            message.body.startsWith("Stopped @codex-reborn-route on ")),
      ),
      "a channel stop's confirmation stays on the command; it does not post another message",
    );
    const confirmedStopCatalog = await json(await worker.fetch("/api/channels", { headers: auth }));
    const confirmedStopChannel = confirmedStopCatalog.channels.find((candidate) => candidate.id === channelId);
    assert.ok(
      !registrationPresence(confirmedStopChannel, registration).instances?.some(
        (instance) => instance.id === resumed.resumeInstanceId,
      ),
      "an authenticated already-absent host result must remove the ghost Instance from channel presence",
    );
  } finally {
    if (agent) agent.ws.close();
    if (human) human.ws.close();
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});
