import assert from "node:assert/strict";

import test from "node:test";

import {
  machineSpawnCommand,
  publishClaimedAgentLaunches,
} from "../src/postgres-agent-launch-coordinator.ts";

function launch(index, overrides = {}) {
  return {
    launch_id: `launch-${index}`,
    channel_id: "channel-1",
    space_id: "space-1",
    owner_user_id: "owner-1",
    run_id: `run-${index}`,
    instance_id: `instance-${index}`,
    execution_key: `execution-${index}`,
    control_id: `control-${index}`,
    machine_id: "machine-1",
    hostname: "host-1",
    state: "prepared",
    spawn_payload_json: { type: "machine_spawn_agent", requestId: `control-${index}`,
      runId: `run-${index}`, instanceId: `instance-${index}`,
      executionKey: `execution-${index}` },
    attempt: 0,
    run_version: 1,
    instance_version: 1,
    route_version: 2,
    route_updated_at: "2026-09-05T00:00:00.000Z",
    placement_epoch: 1,
    directory_published: false,
    command_durable_at: null,
    ...overrides,
  };
}

/** The daemon's answer to an issued batch: each command pending on an online daemon. */
function pendingIssue(batch) {
  return ({ daemon: { status: "online" }, commands: batch.map((row) => ({
    controlId: row.control_id, status: "pending", createdAt: "2026-09-05T00:00:01Z",
  })) });
}

/** The ports of a publication that only issues: nothing reconciles, and settling records nothing. */
const ISSUE_ONLY = {
  async readBatch() { throw new Error("unexpected reconcile"); },
  async settle() {},
};

const claimed = (rows) => rows.map((row) => ({
  shard: { shardId: "shard-0", database: {} },
  row,
}));

test("Machine spawn publication canonicalizes PostgreSQL Launch coordinates", () => {
  const row = launch(1, { spawn_payload_json: {
    type: "machine_spawn_agent", requestId: "stale-control", spaceId: "stale-space",
    channelId: "stale-channel", runId: "stale-run", instanceId: "stale-instance",
    executionKey: "stale-execution", launchId: "stale-launch",
  } });
  assert.deepEqual(machineSpawnCommand(row), {
    type: "machine_spawn_agent", requestId: "control-1", spaceId: "space-1",
    channelId: "channel-1", runId: "run-1", instanceId: "instance-1",
    executionKey: "execution-1", launchId: "launch-1",
  });
});

test("co-located prepare routes skip a redundant coordinator directory checkout", async () => {
  const rows = [launch(1, { directory_published: true }),
    launch(2, { directory_published: true })];
  let directoryCalls = 0;
  await publishClaimedAgentLaunches(claimed(rows), {
    async publishDirectory() { directoryCalls += 1; },
    async issueBatch(batch) {
      return pendingIssue(batch);
    },
    ...ISSUE_ONLY,
  });
  assert.equal(directoryCalls, 0);
});

test("three same-machine Launches publish directory and commands once", async () => {
  const calls = { directory: [], issue: [], read: [], settle: [] };
  const rows = [launch(1), launch(2), launch(3)];
  await publishClaimedAgentLaunches(claimed(rows), {
    async publishDirectory(mutations) { calls.directory.push(mutations); },
    async issueBatch(batch) {
      calls.issue.push(batch);
      return ({ daemon: { status: "online" }, commands: batch.map((row) => ({
        controlId: row.control_id, status: "pending", createdAt: "2026-09-05T00:00:01.000Z",
      })) });
    },
    async readBatch(batch) { calls.read.push(batch); return ({ commands: [] }); },
    async settle(_database, shardId, settlements) { calls.settle.push({ shardId, settlements }); },
  });
  assert.equal(calls.directory.length, 1);
  assert.equal(calls.directory[0].length, 6);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.issue[0].length, 3);
  assert.equal(calls.read.length, 0);
  assert.equal(calls.settle.length, 1);
  assert.deepEqual(calls.settle[0].settlements.map((item) => item.state),
    ["queued", "queued", "queued"]);
});

test("a full 100-Launch claim for one machine remains one issue batch and one wake boundary", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => launch(index));
  let issues = 0;
  await publishClaimedAgentLaunches(claimed(rows), {
    async publishDirectory() {},
    async issueBatch(batch) {
      issues += 1;
      assert.equal(batch.length, 100);
      return pendingIssue(batch);
    },
    ...ISSUE_ONLY,
  });
  assert.equal(issues, 1);
});

test("multi-shard claims keep each directory publication within its 200-route bound", async () => {
  const items = Array.from({ length: 200 }, (_, index) => ({
    shard: { shardId: index < 100 ? "shard-0" : "shard-1", database: {} },
    row: launch(index, { space_id: index < 100 ? "space-0" : "space-1" }),
  }));
  const directorySizes = [];
  await publishClaimedAgentLaunches(items, {
    async publishDirectory(mutations) { directorySizes.push(mutations.length); },
    async issueBatch(batch) {
      return pendingIssue(batch);
    },
    ...ISSUE_ONLY,
  });
  assert.deepEqual(directorySizes, [200, 200]);
});

test("durable commands reconcile as one batch and isolate per-target failure", async () => {
  const rows = [launch(1, { state: "admitted", command_durable_at: "2026-09-05T00:00:01Z" }),
    launch(2, { state: "queued", command_durable_at: "2026-09-05T00:00:01Z" }),
    launch(3, { state: "queued", command_durable_at: "2026-09-05T00:00:01Z" })];
  let issues = 0;
  const settled = [];
  await publishClaimedAgentLaunches(claimed(rows), {
    async publishDirectory() {},
    async issueBatch() { issues += 1; throw new Error("must not reissue"); },
    async readBatch(batch) {
      return ({ daemon: { status: "online" }, commands: batch.map((row, index) => ({
        controlId: row.control_id,
        status: index === 1 ? "failed" : "completed",
        createdAt: "2026-09-05T00:00:01.000Z",
        completedAt: "2026-09-05T00:00:02.000Z",
        result: index === 1 ? { ok: false, error: "invalid runtime" }
          : { ok: true, spawnedAt: "2026-09-05T00:00:01.500Z" },
      })) });
    },
    async settle(_database, _shardId, settlements) { settled.push(...settlements); },
  });
  assert.equal(issues, 0);
  assert.deepEqual(settled.map((item) => item.state), ["spawned", "failed", "spawned"]);
  assert.deepEqual(settled.filter((item) => item.state === "spawned")
    .map((item) => item.spawnedAt),
  ["2026-09-05T00:00:01.500Z", "2026-09-05T00:00:01.500Z"]);
});

test("a connected Launch still reconciles late durable spawn evidence", async () => {
  const row = launch(1, { state: "connected", command_durable_at: "2026-09-05T00:00:01Z" });
  const settled = [];
  await publishClaimedAgentLaunches(claimed([row]), {
    async publishDirectory() {},
    async issueBatch() { throw new Error("must not reissue"); },
    async readBatch() {
      return ({ commands: [{
        controlId: row.control_id,
        status: "completed",
        createdAt: "2026-09-05T00:00:01.000Z",
        completedAt: "2026-09-05T00:00:03.000Z",
        result: { ok: true, spawnedAt: "2026-09-05T00:00:02.000Z" },
      }] });
    },
    async settle(_database, _shardId, settlements) { settled.push(...settlements); },
  });
  assert.equal(settled.length, 1);
  assert.equal(settled[0].state, "spawned");
  assert.equal(settled[0].spawnedAt, "2026-09-05T00:00:02.000Z");
});

test("a connected Launch whose command cannot say when it spawned records its connection", async () => {
  const rows = [
    launch(1, { state: "connected", connected_at: "2026-09-05T00:00:04.000Z" }),
    launch(2, { state: "connected", connected_at: new Date("2026-09-05T00:00:05.000Z") }),
    launch(3, { state: "connected", connected_at: "2026-09-05T00:00:06.000Z" }),
  ];
  const settled = [];
  await publishClaimedAgentLaunches(claimed(rows), {
    async publishDirectory() {},
    async issueBatch() { throw new Error("must not reissue"); },
    async readBatch() {
      return ({ delivered: 0, commands: [
        { controlId: rows[1].control_id, status: "pending", createdAt: "2026-09-05T00:00:01.000Z" },
        { controlId: rows[2].control_id, status: "failed", result: { ok: false, error: "gone" } },
      ] });
    },
    async settle(_database, _shardId, settlements) { settled.push(...settlements); },
  });
  assert.deepEqual(settled.map((item) => [item.state, item.spawnedAt, item.retryable, item.errorCode]), [
    ["spawned", "2026-09-05T00:00:04.000Z", false, undefined],
    ["spawned", "2026-09-05T00:00:05.000Z", false, undefined],
    ["spawned", "2026-09-05T00:00:06.000Z", false, undefined],
  ]);
  assert.equal(settled[1].commandDurableAt, "2026-09-05T00:00:01.000Z");
});

test("machine publication concurrency is capped at eight", async () => {
  let active = 0;
  let maximum = 0;
  const rows = Array.from({ length: 12 }, (_, index) => launch(index, {
    machine_id: `machine-${index}`,
    hostname: `host-${index}`,
  }));
  await publishClaimedAgentLaunches(claimed(rows), {
    async publishDirectory() {},
    async issueBatch(batch) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return pendingIssue(batch);
    },
    ...ISSUE_ONLY,
  });
  assert.equal(maximum, 8);
});

test("spawn source context comes only from the scoped immutable launch witness", () => {
  const source = { channelId: "channel-1", messageId: "source-1", entityVersion: 1, sequence: 1, bodyHash: "a".repeat(64) };
  const row = launch(1, { channel_id: "channel-1", trigger_id: "source-1", initial_source_json: source,
    spawn_payload_json: { context: { goal: { active: true }, initialMessageSource: { ...source, messageId: "forged" } } } });
  const command = machineSpawnCommand(row);
  assert.deepEqual(command.context.initialMessageSource, source);
  assert.deepEqual(command.context.goal, { active: true });
  assert.equal(command.sourceMessageId, "source-1");
  for (const initial_source_json of [null, { ...source, channelId: "foreign" }, { ...source, messageId: "foreign" }]) {
    assert.equal(machineSpawnCommand({ ...row, initial_source_json }).context.initialMessageSource, undefined);
  }
});

// Channel cb36dbb1 (2026-09-26): targeted wakes queued behind one global
// object's reconciliation for up to 9 minutes. Claiming now belongs to each
// Channel's own coordinator; the global one reconciles and wakes stragglers.
