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
  waitForChannelHistoryMessage,
} from "./agent-mention-spawn.fixture.mjs";
import {
  channelSpaceId, connectDaemon, createClosedChannel, createWorkspace, isSpawnOf, registerTestAgent, sendSpawnResult,
  startPgHubWorker, testMachine,
} from "./agent-launch-postgres.fixture.mjs";

/**
 * Launch a registered Run on the connected daemon and return the spawn
 * command it holds a lease on.
 */
async function spawnRenewableRun(worker, daemon, { slug, machineId, hostId }, label) {
  const channelId = (await createClosedChannel(worker, `${slug}-${randomUUID()}`)).id;
  const canonicalCwd = `/tmp/xmatrix-${slug}-renew-${randomUUID()}`;
  await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: `${slug}-renew-workspace` });
  const registration = await registerTestAgent(worker, { token: MOCK_TOKEN,
    spaceId: await channelSpaceId(channelId), machineId, displayName: `codex-${slug}-renew`, canonicalCwd });
  const started = await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ body: `@auto harness:codex machine:${machineId} pwd:"${canonicalCwd}" keep the spawn lease live` }),
  });
  assert.equal(started.status, 200, await started.text());
  return daemon.inbox.waitFor(
    (message) => message.type === "machine_spawn_agent" && isSpawnOf(message, registration),
    label,
  );
}

/**
 * A renewal extends the spawn's lease but keeps its completion fence, so the
 * daemon still reports the started spawn under the lease it was issued.
 */
async function completeRenewedSpawn(worker, daemon, command, originalLease, leaseUntil) {
  assert.ok(Date.parse(leaseUntil) > Date.now() + 45_000);
  assert.deepEqual(command.relayLease, originalLease, "renewal must keep the completion fence stable");
  const completed = await worker.fetch("/api/daemon/spawn-result", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${daemon.machineCredential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: command.requestId,
      launchId: command.launchId,
      runId: command.runId,
      executionKey: command.executionKey,
      instanceId: command.instanceId,
      machineId: command.workspace.machineId,
      canonicalCwd: command.workspace.canonicalCwd,
      channelId: command.channelId,
      agentName: command.agentName,
      identityId: command.identityId,
      ok: true,
      pid: 4242,
      relayLease: originalLease,
    }),
  });
  assert.equal(completed.status, 200, await completed.text());
}

function renewSpawnLease(worker, daemon, requestId, relayLease) {
  return worker.fetch("/api/daemon/command-lease/renew", {
    method: "POST", headers: { Authorization: `Bearer ${daemon.machineCredential}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId, relayLease }),
  });
}

test("a newer daemon connection fences the prior Workstation epoch from claiming commands", async () => {
  const userId = `daemon-epoch-fence-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "daemon-epoch-fence@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Daemon Epoch Fence",
    },
  });
  let oldDaemon;
  let newDaemon;
  try {
    const { hostId, machineId } = testMachine("epoch");
    oldDaemon = await connectDaemon(worker, { machineId, hostId });
    newDaemon = await connectDaemon(worker, { machineId, hostId });
    assert.equal(newDaemon.connectionEpoch, oldDaemon.connectionEpoch + 1);

    const claim = (epoch) => worker.fetch(
      `/api/daemon/control?machineId=${encodeURIComponent(machineId)}` +
      `&hostId=${encodeURIComponent(hostId)}&connectionEpoch=${epoch}`,
      { headers: { Authorization: `Bearer ${newDaemon.machineCredential}` } },
    );
    assert.equal((await claim(oldDaemon.connectionEpoch)).status, 409);
    assert.equal((await claim(newDaemon.connectionEpoch)).status, 200);
  } finally {
    if (newDaemon) newDaemon.ws.close();
    if (oldDaemon) oldDaemon.ws.close();
    await worker.stop();
  }
});

test("a Workstation renews an exact spawn lease without rotating its completion fence", async () => {
  const userId = `daemon-lease-renew-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "daemon-lease-renew@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Daemon Lease Renew",
    },
  });
  let daemon;
  try {
    const { hostId, machineId } = testMachine("lease");
    daemon = await connectDaemon(worker, { machineId, hostId });
    const command = await spawnRenewableRun(worker, daemon, { slug: "lease", machineId, hostId },
      "spawn command whose lease will renew");
    const originalLease = structuredClone(command.relayLease);
    const renew = await renewSpawnLease(worker, daemon, command.requestId, command.relayLease);
    const renewBody = await renew.text();
    assert.equal(renew.status, 200, renewBody);
    const renewed = JSON.parse(renewBody);
    assert.equal(renewed.ok, true);
    await completeRenewedSpawn(worker, daemon, command, originalLease, renewed.leaseUntil);

    const terminalRenew = await renewSpawnLease(worker, daemon, command.requestId, originalLease);
    assert.equal(terminalRenew.status, 409);
  } finally {
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});

test("a Workstation renews an exact spawn lease over the live socket", async () => {
  const userId = `daemon-socket-lease-renew-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "daemon-socket-lease-renew@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Daemon Socket Lease Renew",
    },
  });
  let daemon;
  try {
    const { hostId, machineId } = testMachine("socket-lease");
    daemon = await connectDaemon(worker, { machineId, hostId });
    const command = await spawnRenewableRun(worker, daemon, { slug: "socket-lease", machineId, hostId },
      "spawn command whose live socket will renew");
    const originalLease = structuredClone(command.relayLease);
    const requestId = `renew-${randomUUID()}`;
    daemon.ws.send(JSON.stringify({
      type: "machine_command_lease_renew",
      requestId,
      controlId: command.requestId,
      relayLease: command.relayLease,
    }));
    const renewed = await daemon.inbox.waitFor(
      (message) => message.type === "machine_command_lease_renewed" && message.requestId === requestId,
      "socket lease renewal",
    );
    assert.equal(renewed.controlId, command.requestId);
    await completeRenewedSpawn(worker, daemon, command, originalLease, renewed.leaseUntil);

    daemon.ws.send(JSON.stringify({
      type: "machine_command_lease_renew",
      requestId: `renew-terminal-${randomUUID()}`,
      controlId: command.requestId,
      relayLease: originalLease,
    }));
    const terminal = await daemon.inbox.waitFor(
      (message) => message.type === "error",
      "terminal socket lease renewal must fail closed",
    );
    assert.match(String(terminal.message || ""), /lease|not found|stale|terminal|complete/i);
    assert.ok(["machine_command_stale_lease", "machine_command_not_leased"].includes(terminal.failure?.code));
  } finally {
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});

test("a mention to an offline Workstation is refused, and after reconnect it launches and the agent reply reaches the channel", async () => {
  const userId = `daemon-reconnect-e2e-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "daemon-reconnect-e2e@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Daemon Reconnect E2E",
    },
  });
  let firstDaemon;
  let daemon;
  let agent;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const { hostId, machineId } = testMachine("workstation");
    const channelId = (await createClosedChannel(worker, `reconnect-${randomUUID()}`)).id;
    firstDaemon = await connectDaemon(worker, { machineId, hostId });
    const canonicalCwd = `/tmp/xmatrix-reconnect-${randomUUID()}`;
    await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: "reconnect-workspace" });

    firstDaemon.ws.close();
    await sleep(100);
    const registration = await registerTestAgent(worker, { token: MOCK_TOKEN,
      spaceId: await channelSpaceId(channelId), machineId, displayName: "codex-reconnect-route", canonicalCwd });
    const mention = `@auto harness:codex machine:${machineId} pwd:"${canonicalCwd}" resume after Workstation reconnect`;
    const accepted = await postChannelMessage(worker, MOCK_TOKEN, channelId, mention);
    // A registered launch is prepared against an online Workstation. One that
    // is offline is refused as that fact, not queued behind it.
    const offlineMessageId = accepted.message.messageId;
    let offline;
    for (let attempt = 0; attempt < 100 && !offline?.rejections?.length; attempt += 1) {
      offline = await json(await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/agent-launches/query`, {
        method: "POST", headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ sourceMessageIds: [offlineMessageId], pageSize: 20 }) }));
      if (!offline.rejections?.length) await sleep(50);
    }
    assert.deepEqual(offline.launches, []);
    assert.equal(offline.rejections[0].code, "registration_daemon_offline");

    daemon = await connectDaemon(worker, { machineId, hostId });
    await postChannelMessage(worker, MOCK_TOKEN, channelId, mention);
    const command = await daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent"
        && message.channelId === channelId
        && isSpawnOf(message, registration),
      "queued machine spawn after reconnect",
    );
    // Rolling-upgrade compatibility: an older daemon generation does not echo the new
    // optional instanceId. A legacy spawn without repo-pool metadata remains
    // valid; pooled metadata would require the exact instanceId.
    sendSpawnResult(daemon, command, { instanceId: undefined, ok: true, pid: 4242 });
    const runToken = await mintAgentRunToken(worker, daemon, command, channelId);
    agent = await connectAgent(worker, runAgentConnection(command, channelId, { machineId, hostId }), runToken);
    const joined = await agent.request({ type: "join_channel", channelId, historyLimit: 0 });
    assert.equal(joined.type, "channel_joined");
    const reply = "Workstation reconnected and the queued request was delivered.";
    await postChannelMessage(worker, runToken, channelId, reply);
    const delivered = await waitForChannelHistoryMessage(
      worker,
      MOCK_TOKEN,
      channelId,
      (message) => message.body === reply,
      "reconnected Workstation reply",
    );
    assert.equal(delivered.from.agentName, command.agentName);
  } finally {
    if (agent) agent.ws.close();
    if (daemon) daemon.ws.close();
    if (firstDaemon) firstDaemon.ws.close();
    await worker.stop();
  }
});
