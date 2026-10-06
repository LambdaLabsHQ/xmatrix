import { xmatrixRepositoryInstallation, startGitHubUserWorker } from "./support/github-user-worker.mjs";
import {
  assert,
  connectAgent,
  json,
  mintAgentRunToken,
  MOCK_TOKEN,
  randomUUID,
  sleep,
  test,
  waitForChannelHistoryMessage,
} from "./agent-mention-spawn.fixture.mjs";
import {
  channelSpaceId, connectDaemon, createClosedChannel, createWorkspace, isSpawnOf, postAutoLaunch, registerTestAgent,
  sendSpawnResult, sendStopResult, startPgHubWorker, testMachine,
} from "./agent-launch-postgres.fixture.mjs";
import {
  grantRegistrationRepository,
} from "./registration-launch.fixture.mjs";

test("owner delete makes an Agent Instance permanently unavailable to reborn", async () => {
  const userId = `daemon-reborn-fence-e2e-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "daemon-reborn-fence-e2e@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Daemon Reborn Fence E2E",
    },
  });
  let daemon;
  let foreignDaemon;
  let firstAgent;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const { hostId, machineId } = testMachine("workstation-fence");
    const channelId = (await createClosedChannel(worker, `reborn-fence-${randomUUID()}`)).id;
    daemon = await connectDaemon(worker, { machineId, hostId });
    const canonicalCwd = `/tmp/xmatrix-reborn-fence-${randomUUID()}`;
    await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: "reborn-fence-workspace" });

    const registration = await registerTestAgent(worker, { token: MOCK_TOKEN,
      spaceId: await channelSpaceId(channelId), machineId, displayName: "codex-reborn-fence", canonicalCwd });
    await postAutoLaunch(worker, { channelId, machineId, canonicalCwd }, "seed before stop fence");
    const first = await daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" && message.channelId === channelId &&
        isSpawnOf(message, registration),
      "initial machine spawn before stop fence",
    );
    sendSpawnResult(daemon, first, { instanceId: undefined, ok: true, pid: 4242 });

    foreignDaemon = await connectDaemon(worker, testMachine("foreign-fence"));
    foreignDaemon.ws.send(JSON.stringify({
      type: "machine_run_exited",
      runId: first.runId,
      executionKey: first.executionKey,
      agentId: first.identityId,
      agentName: first.agentName,
      pid: 4242,
      status: "simulated foreign daemon exit",
      exitCode: 0,
    }));
    await foreignDaemon.inbox.waitFor(
      (message) => message.type === "error",
      "foreign daemon exit rejection",
    );

    const firstToken = await mintAgentRunToken(worker, daemon, first, channelId);
    firstAgent = await connectAgent(worker, {
      identityId: first.identityId,
      name: first.agentName,
      agentType: "codex",
      clientVersion: "0.16.698",
      capabilities: ["chat", "tools"],
      metadata: {
        tool: "codex",
        machineId,
        hostId,
        workspaceMachineId: first.workspace.machineId,
        workspaceCwd: first.workspace.canonicalCwd,
        workspaceName: first.workspace.displayName,
        cwd: first.workspace.canonicalCwd,
        runId: first.runId,
        executionKey: first.executionKey,
        autoJoinChannelId: channelId,
      },
    }, firstToken);
    const liveInstanceId = firstAgent.agent?.instanceId || firstAgent.agent?.id;
    assert.equal(typeof liveInstanceId, "string");
    assert.ok(liveInstanceId.length > 0, "first connect must expose instanceId");

    // Instance pause/resume is retired: an Instance is live or it is not. A
    // stale client body must fail closed rather than silently do nothing.
    const instanceRoute =
      `/api/spaces/${encodeURIComponent(registration.spaceId)}/channels/${encodeURIComponent(channelId)}/agent-instances/${encodeURIComponent(liveInstanceId)}`;
    for (const retired of [{ paused: true }, { action: "resume" }]) {
      const response = await worker.fetch(instanceRoute, {
        method: "PATCH",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(retired),
      });
      assert.equal(response.status, 400, await response.clone().text());
    }

    // Product delete is a strict two-phase operation: typed abandon must
    // complete before Authority terminal/offline and Runtime trace purge.
    const abandonCommandPromise = daemon.inbox.waitFor(
      (message) => message.type === "machine_stop_agent" &&
        message.runId === first.runId,
      "owner delete rolling-compatible stop",
    );
    let deleteSettled = false;
    const stoppedPromise = worker.fetch(instanceRoute, { method: "DELETE", headers: auth }).finally(() => { deleteSettled = true; });
    const abandonCommand = await abandonCommandPromise;
    assert.equal(abandonCommand.instanceId, liveInstanceId);
    assert.equal(abandonCommand.agentId, liveInstanceId, "a Run's actor is its Instance");
    assert.equal(abandonCommand.worktreeDisposition, undefined);
    assert.equal(abandonCommand.resumeSessionKey, undefined);
    await sleep(50);
    assert.equal(deleteSettled, false, "DELETE must not terminalize before abandon completes");
    sendStopResult(daemon, abandonCommand, { instanceId: `${abandonCommand.instanceId}:mismatch`, ok: true, pid: 4242 });
    await sleep(50);
    assert.equal(deleteSettled, false, "mismatched abandon result must not terminalize DELETE");
    sendStopResult(daemon, abandonCommand, { ok: true, pid: 4242 });
    const stopped = await stoppedPromise;
    assert.equal(stopped.status, 200, await stopped.text());
    firstAgent.ws.close();
    firstAgent = undefined;

    let sawDeletedSpawn = false;
    void daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" &&
        message.channelId === channelId && message.resume === true,
      "unexpected reborn spawn after owner delete",
      500,
    ).then(() => { sawDeletedSpawn = true; }).catch(() => {});
    const deletedReborn = await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: "@codex-reborn-fence:1:reborn after owner delete" }),
    });
    assert.equal(deletedReborn.status, 200);
    await sleep(500);
    assert.equal(sawDeletedSpawn, false, "deleted Agent Instance must remain unrecoverable by reborn");
  } finally {
    if (firstAgent) firstAgent.ws.close();
    if (foreignDaemon) foreignDaemon.ws.close();
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});

test("owner delete fences an in-flight remote-repo spawn before abandoning its pooled slot", async () => {
  const userId = `daemon-starting-delete-e2e-${randomUUID()}`;
  const installationId = "starting-delete-installation";
  const github = await xmatrixRepositoryInstallation(installationId);
  const worker = await startGitHubUserWorker({ id: userId, email: "daemon-starting-delete-e2e@example.com", name: "Daemon Starting Delete E2E" }, github.url);
  let daemon;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const { hostId, machineId } = testMachine("starting-delete");
    const channelId = (await createClosedChannel(worker, `starting-delete-${randomUUID()}`)).id;
    daemon = await connectDaemon(worker, { machineId, hostId });

    const registration = await registerTestAgent(worker, { token: MOCK_TOKEN,
      spaceId: await channelSpaceId(channelId), machineId, displayName: "codex-starting-delete" });
    await grantRegistrationRepository(worker, { token: MOCK_TOKEN, key: registration,
      repository: "LambdaLabsHQ/xmatrix", installationId });
    const started = await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: `@auto harness:codex machine:${machineId} repo:LambdaLabsHQ/xmatrix delete during spawn` }),
    });
    assert.equal(started.status, 200, await started.text());
    const spawn = await daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" &&
        message.channelId === channelId && isSpawnOf(message, registration),
      "remote-repo spawn before concurrent delete",
    );
    assert.equal(typeof spawn.instanceId, "string");
    // Admitted: from here the daemon may be starting the process.
    await mintAgentRunToken(worker, daemon, spawn, channelId);

    const abandonCommandPromise = daemon.inbox.waitFor(
      (message) => message.type === "machine_stop_agent" && message.runId === spawn.runId,
      "typed abandon after in-flight spawn completes",
    );
    let deleteSettled = false;
    const deletePromise = worker.fetch(
      `/api/spaces/${encodeURIComponent(registration.spaceId)}/channels/${encodeURIComponent(channelId)}/agent-instances/${encodeURIComponent(spawn.instanceId)}`,
      { method: "DELETE", headers: auth },
    ).finally(() => { deleteSettled = true; });
    // Awaited below; an earlier failure must not surface as its rejection.
    deletePromise.catch(() => {});
    await sleep(100);
    assert.equal(deleteSettled, false, "DELETE must wait for the exact in-flight spawn intent");

    const repoPool = {
      repoIdentity: "github.com/lambdalabshq/xmatrix",
      repoKeyId: "a".repeat(64),
      slotId: "c".repeat(32),
    };
    sendSpawnResult(daemon, spawn, { ok: true, pid: 4343, metadata: { repoPool } });

    const abandon = await abandonCommandPromise;
    assert.equal(abandon.instanceId, spawn.instanceId);
    assert.equal(abandon.agentId, spawn.instanceId, "a Run's actor is its Instance");
    assert.equal(abandon.worktreeDisposition, "abandon");
    assert.equal(abandon.resumeSessionKey, spawn.resumeSessionKey);
    assert.deepEqual(
      {
        repoIdentity: abandon.repoIdentity,
        repoKeyId: abandon.repoKeyId,
        slotId: abandon.slotId,
      },
      repoPool,
    );
    sendStopResult(daemon, abandon, { repoIdentity: abandon.repoIdentity, repoKeyId: abandon.repoKeyId,
      slotId: abandon.slotId, ok: true, pid: 4343 });
    const deleted = await deletePromise;
    assert.equal(deleted.status, 200, await deleted.text());

    const failedChannelId = (await createClosedChannel(worker, `failed-start-delete-${randomUUID()}`)).id;
    const failedStarted = await worker.fetch(`/api/channels/${encodeURIComponent(failedChannelId)}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: `@auto harness:codex machine:${machineId} repo:LambdaLabsHQ/xmatrix delete after failed acknowledgement` }),
    });
    assert.equal(failedStarted.status, 200, await failedStarted.text());
    const failedSpawn = await daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" &&
        message.channelId === failedChannelId && isSpawnOf(message, registration),
      "remote-repo spawn whose acknowledgement fails after admission",
      30_000,
    );
    await mintAgentRunToken(worker, daemon, failedSpawn, failedChannelId);
    const failedRepoPool = {
      repoIdentity: "github.com/lambdalabshq/xmatrix",
      repoKeyId: "d".repeat(64),
      slotId: "f".repeat(32),
    };
    const failedAbandonPromise = daemon.inbox.waitFor(
      (message) => message.type === "machine_stop_agent" && message.runId === failedSpawn.runId,
      "typed abandon after failed spawn acknowledgement retained pool authority",
    );
    const failedDeletePromise = worker.fetch(
      `/api/spaces/${encodeURIComponent(registration.spaceId)}/channels/${encodeURIComponent(channelId)}/agent-instances/${encodeURIComponent(failedSpawn.instanceId)}`,
      { method: "DELETE", headers: auth },
    );
    sendSpawnResult(daemon, failedSpawn, { ok: false, error: "registry persistence and child rollback were not proven", metadata: { repoPool: failedRepoPool } });
    const failedAbandon = await failedAbandonPromise;
    assert.equal(failedAbandon.worktreeDisposition, "abandon");
    assert.equal(failedAbandon.resumeSessionKey, failedSpawn.resumeSessionKey);
    assert.deepEqual(
      {
        repoIdentity: failedAbandon.repoIdentity,
        repoKeyId: failedAbandon.repoKeyId,
        slotId: failedAbandon.slotId,
      },
      failedRepoPool,
    );
    sendStopResult(daemon, failedAbandon, { repoIdentity: failedAbandon.repoIdentity,
      repoKeyId: failedAbandon.repoKeyId, slotId: failedAbandon.slotId, ok: true });
    const failedDeleted = await failedDeletePromise;
    assert.equal(failedDeleted.status, 200, await failedDeleted.text());
  } finally {
    if (daemon) daemon.ws.close();
    await worker.stop();
    await github.close();
  }
});

test("a failed daemon stop result surfaces a channel notice that the process may still run", async () => {
  const userId = `daemon-stop-failed-e2e-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "daemon-stop-failed-e2e@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Daemon Stop Failed E2E",
    },
  });
  let daemon;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const { hostId, machineId } = testMachine("workstation-stop-failed");
    const channelId = (await createClosedChannel(worker, `stop-failed-${randomUUID()}`)).id;
    daemon = await connectDaemon(worker, { machineId, hostId });
    const canonicalCwd = `/tmp/xmatrix-stop-failed-${randomUUID()}`;
    await createWorkspace(worker, { machineId, hostId, canonicalCwd, displayName: "stop-failed-workspace" });

    await registerTestAgent(worker, { token: MOCK_TOKEN,
      spaceId: await channelSpaceId(channelId), machineId, displayName: "codex-stop-failed", canonicalCwd });
    await postAutoLaunch(worker, { channelId, machineId, canonicalCwd }, "run before failed stop");
    const spawned = await daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" && message.channelId === channelId,
      "spawn before failed stop",
    );

    const stopCommandPromise = daemon.inbox.waitFor(
      (message) => message.type === "machine_stop_agent" && message.runId === spawned.runId,
      "failed-stop machine stop command",
    );
    assert.equal((await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: "@codex-stop-failed:1:stop" }),
    })).status, 200);
    const stopCommand = await stopCommandPromise;

    const hostError =
      "process tree still alive after termination: [9999] " +
      "(wrapper /Users/dev/.local/bin/xmatrix claude --resume s-123)";
    sendStopResult(daemon, stopCommand, { ok: false, pid: 9999, error: hostError });
    const failureNotice = await waitForChannelHistoryMessage(
      worker,
      MOCK_TOKEN,
      channelId,
      (message) => typeof message.body === "string" &&
        message.body.startsWith("Couldn't stop @codex-stop-failed on "),
      "failed stop channel notice",
    );
    assert.ok(
      failureNotice.body.includes("may still be running"),
      "failure notice must warn that the process may still be running",
    );
    // The raw daemon error (host paths, command lines) must never enter ANY
    // channel-visible field: history metadata ships to every member, so
    // only the stable classification code may appear anywhere in the message.
    const serializedNotice = JSON.stringify(failureNotice);
    assert.ok(
      !serializedNotice.includes("process tree still alive") &&
        !serializedNotice.includes("/Users/dev/") &&
        !serializedNotice.includes("--resume"),
      "no channel-visible field may leak the raw daemon error",
    );
    assert.equal(failureNotice.metadata?.stopOutcome, "failed");
    assert.equal(failureNotice.metadata?.stopFailureCode, "process_tree_still_alive");
    assert.equal(failureNotice.metadata?.stopFailureDetail, undefined);

    // A duplicate late result must not duplicate the notice.
    sendStopResult(daemon, stopCommand, { ok: false, pid: 9999, error: hostError });
    await sleep(200);
    const history = await json(await worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/history?limit=50`,
      { headers: auth },
    ));
    const failureNotices = (history.messages || []).filter(
      (message) => typeof message.body === "string" &&
        message.body.startsWith("Couldn't stop @codex-stop-failed on "),
    );
    assert.equal(failureNotices.length, 1, "late duplicate stop results must not duplicate the notice");
  } finally {
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});
