import {
  assert,
  authHeaders,
  channelHistory,
  channelSpaceId,
  connectDaemon,
  createRoutableAgent,
  createSpaceAndChannel,
  createTask,
  isSpawnOf,
  json,
  listTasks,
  MOCK_TOKEN,
  randomUUID,
  sendSpawnResult,
  startPgHubWorker,
  test,
  waitForChannelHistoryMessage,
  waitForTask,
} from "./automation-api.fixture.mjs";
import { inWorkerTransaction } from "./registration-launch.fixture.mjs";

test("due Automation commits one canonical message with App metadata and no duplicate", async () => {
  const unique = randomUUID();
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: `scheduled-message-delivery-${unique}`,
      XMATRIX_MOCK_AUTH_EMAIL: "scheduled-message-delivery@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Scheduled Message Delivery",
      RELAY_AUTOMATION_EXECUTION_ENABLED: "true",
      XMATRIX_MOCK_SCHEDULE_DELAY_MS: "1200",
    },
  });
  try {
    const { space } = await createSpaceAndChannel(worker, unique);
    const visibleBody = `@github:issue_to_channel:LambdaLabsHQ/xmatrix scheduled-${unique}`;
    const task = await createTask(worker, {
      spaceId: space.id,
      name: "Canonical scheduled message",
      message: { body: visibleBody },
      intervalMinutes: 15,
    });
    // Each occurrence runs in a fresh conversation, not the Automation's own.
    const persisted = await waitForTask(worker, task.id,
      (candidate) => candidate.deliveryCount === 1 && Boolean(candidate.lastChannelId));
    assert.notEqual(persisted.lastChannelId, task.channelId);
    const channel = { id: persisted.lastChannelId };
    const delivered = await waitForChannelHistoryMessage(
      worker,
      MOCK_TOKEN,
      channel.id,
      (message) => message.body.includes(`scheduled-${unique}`),
      "canonical scheduled message",
      15_000,
    );
    assert.equal(delivered.metadata?.appMentions?.[0]?.appId, "github");
    assert.equal(delivered.metadata?.appMentions?.[0]?.actionId, "issue_to_channel");
    assert.equal(persisted.lastMessageId, delivered.messageId);
    assert.deepEqual(persisted.latestExecution.runs, [], "message delivery alone proves no Run");
    const [occurrence] = await inWorkerTransaction(worker, tx => tx.query({ text:
      "SELECT run_id,instance_id FROM data.automation_occurrences WHERE automation_id=$1",
    values: [task.id] }));
    assert.deepEqual(occurrence, { run_id: null, instance_id: null }, "message occurrences reserve no phantom Run");
    assert.equal(persisted.lastRunAt !== undefined, true);
    assert.equal(Date.parse(persisted.nextRunAt) > Date.now(), true);
    assert.equal((await channelHistory(worker, task.channelId))
      .some((message) => message.body.includes(`scheduled-${unique}`)), false);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const matching = (await channelHistory(worker, channel.id))
      .filter((message) => message.body.includes(`scheduled-${unique}`));
    assert.equal(matching.length, 1);
  } finally {
    await worker.stop();
  }
});

test("scheduled tagged Auto uses the shared post-commit dispatcher without a launch lifetime option", async () => {
  const unique = randomUUID();
  const userId = `scheduled-message-once-${unique}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "scheduled-message-once@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Scheduled Message Once",
      RELAY_AUTOMATION_EXECUTION_ENABLED: "true",
      XMATRIX_MOCK_SCHEDULE_DELAY_MS: "1200",
    },
  });
  let daemon;
  try {
    const machineId = `machine:scheduled-message-once-${unique}`;
    const hostId = `scheduled-message-once-${unique}`;
    daemon = await connectDaemon(worker, { machineId, hostId });
    const { space, channel } = await createSpaceAndChannel(worker, unique, "scheduled-once");
    const { key: registration, canonicalCwd } = await createRoutableAgent(worker, { token: MOCK_TOKEN,
      spaceId: space.id, name: `scheduled-message-agent-${unique}`, machineId, hostId });

    const spawnPromise = daemon.inbox.waitFor(
      (message) => message.type === "machine_spawn_agent" && isSpawnOf(message, registration),
      "scheduled message one-shot spawn",
      20_000,
    );
    // Observe a launch timeout even if task creation fails first.
    void spawnPromise.catch(() => {});
    const task = await createTask(worker, {
      spaceId: await channelSpaceId(channel.id),
      name: "One-shot from scheduled message",
      message: {
        body: `@auto harness:codex machine:${machineId} pwd:"${canonicalCwd}" inspect and report once`,
      },
      intervalMinutes: 15,
    });
    const spawn = await spawnPromise;
    assert.ok(spawn.runId && spawn.launchId && spawn.instanceId && spawn.executionKey);
    assert.equal(spawn.identityId, spawn.instanceId, "a registered Agent acts as its Instance");
    assert.equal(spawn.exitAfterInitialMessage, undefined);
    assert.equal(spawn.workspace.canonicalCwd, canonicalCwd);
    assert.doesNotMatch(spawn.prompt, /@[^\s]+:once:/u);

    const persisted = await waitForTask(
      worker,
      task.id,
      (candidate) => candidate.deliveryCount === 1 && Boolean(candidate.lastMessageId),
    );
    assert.notEqual(persisted.lastMessageId, spawn.runId);
    assert.equal(persisted.lastMessageId, spawn.sourceMessageId,
      "the launch must consume the exact canonical scheduled message");
    // The occurrence's Run works in the occurrence's own conversation.
    assert.equal(spawn.channelId, persisted.lastChannelId);
    assert.notEqual(spawn.channelId, task.channelId);
    assert.deepEqual(persisted.latestExecution.runs?.map(({ runId, instanceId, channelId }) =>
      ({ runId, instanceId, channelId })),
    [{ runId: spawn.runId, instanceId: spawn.instanceId, channelId: spawn.channelId }],
    "the occurrence links the persisted Run created from its exact message");
    assert.equal(persisted.lastRunId, undefined, "a delivered message is not a Run id");
    sendSpawnResult(daemon, spawn, { channelId: spawn.channelId, ok: false, error: "test completed before provider launch" });
  } finally {
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});

test("pausing before due prevents the scheduled message commit", async () => {
  const unique = randomUUID();
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: `scheduled-message-paused-${unique}`,
      XMATRIX_MOCK_AUTH_EMAIL: "scheduled-message-paused@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Scheduled Message Paused",
      RELAY_AUTOMATION_EXECUTION_ENABLED: "true",
      XMATRIX_MOCK_SCHEDULE_DELAY_MS: "2000",
    },
  });
  try {
    const { space } = await createSpaceAndChannel(worker, unique);
    const body = `This paused message must not appear ${unique}`;
    const task = await createTask(worker, {
      spaceId: space.id,
      name: "Pause scheduled message",
      message: { body },
      intervalMinutes: 15,
    });
    const channel = { id: task.channelId };
    const paused = (await json(await worker.fetch(
      `/api/automations/${encodeURIComponent(task.id)}/pause`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ expectedVersion: task.version }),
      },
    ))).automation;
    assert.equal(paused.enabled, false);
    // The 2000ms seed starts when the page reference enables the Automation.
    // This wait is longer, so a pause that did not stick would still deliver.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    assert.equal((await channelHistory(worker, channel.id)).some((message) => message.body === body), false);
    const persisted = (await listTasks(worker)).automations.find((candidate) => candidate.id === task.id);
    assert.equal(persisted.deliveryCount, 0);
  } finally {
    await worker.stop();
  }
});

test("one occurrence associates every concurrent invocation with its own persisted Run", async () => {
  const unique = randomUUID();
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
    XMATRIX_MOCK_AUTH_USER_ID: `scheduled-multiple-${unique}`,
    XMATRIX_MOCK_AUTH_EMAIL: "scheduled-multiple@example.com",
    RELAY_AUTOMATION_EXECUTION_ENABLED: "true", XMATRIX_MOCK_SCHEDULE_DELAY_MS: "1200",
  } });
  let daemon;
  try {
    const machineId = `machine:multiple-${unique}`, hostId = `multiple-${unique}`;
    daemon = await connectDaemon(worker, { machineId, hostId });
    const { space } = await createSpaceAndChannel(worker, unique, "multiple");
    const { key: registration, canonicalCwd } = await createRoutableAgent(worker,
      { token: MOCK_TOKEN, spaceId: space.id, name: `multiple-${unique}`, machineId, hostId });
    const summon = `@auto harness:codex machine:${machineId} pwd:"${canonicalCwd}"`;
    const task = await createTask(worker, { spaceId: space.id, name: "Concurrent occurrence invocations",
      message: { body: `${summon} inspect first\n${summon} inspect second` }, intervalMinutes: 15 });
    const first = await daemon.inbox.waitFor(message => message.type === "machine_spawn_agent" &&
      isSpawnOf(message, registration), "first invocation", 20_000);
    const second = await daemon.inbox.waitFor(message => message.type === "machine_spawn_agent" &&
      isSpawnOf(message, registration) && message.runId !== first.runId, "second invocation", 20_000);
    assert.equal(first.channelId, second.channelId);
    assert.equal(first.sourceMessageId, second.sourceMessageId);
    const persisted = await waitForTask(worker, task.id, candidate => candidate.latestExecution?.runs?.length === 2);
    assert.deepEqual(persisted.latestExecution.runs.map(run => run.runId).sort(), [first.runId, second.runId].sort());
    assert.notEqual(first.instanceId, second.instanceId);
    for (const spawn of [first, second]) sendSpawnResult(daemon, spawn,
      { channelId: spawn.channelId, ok: false, error: "provider startup rejected for regression" });
    const failed = await waitForTask(worker, task.id,
      candidate => candidate.latestExecution?.runs?.every(run => run.status === "failed"));
    assert.equal(failed.latestExecution.runs.length, 2, "failed provider starts remain attributable persisted Runs");
  } finally {
    daemon?.ws.close();
    await worker.stop();
  }
});
