import assert from "node:assert/strict";
import test from "node:test";

import { machineDaemonCommand } from "../src/machines.ts";

test("PostgreSQL Machine issue_batch wakes once after its transaction commits", async () => {
  const wakes = [];
  const { database } = batchDatabase();
  const body = batchBody("batch-1");
  await machineDaemonCommand({
    RELAY_POSTGRES: { connectionString: "postgres://unused" }, RELAY_POSTGRES_SHARD_ID: "next-1" },
  body, { database, async wake(input, result) { wakes.push({ input, result }); } });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].input.action, "issue_batch");
  assert.equal(wakes[0].result.commands.length, 3);
});

test("a wake Runtime did not answer does not mark the daemon offline", async () => {
  const { database, updates, locks } = batchDatabase();
  const result = await machineDaemonCommand({
    RELAY_POSTGRES: { connectionString: "postgres://unused" }, RELAY_POSTGRES_SHARD_ID: "next-1" },
  batchBody("batch-unavailable"), { database, async wake() {
    return { matched: 0, delivered: 0, owners: 0, healed: false, deliverable: false, unavailable: true };
  } });
  assert.equal(locks.length, 1);
  assert.equal(updates.length, 0);
  assert.equal(result.daemon.status, "online");
});

test("a missed wake does not offline a daemon that reconnected onto a newer epoch", async () => {
  let epoch = 0;
  const { database, updates, locks } = batchDatabase(() => {
    epoch += 1;
    return epoch === 1 ? 1 : 2;
  });
  const result = await machineDaemonCommand({
    RELAY_POSTGRES: { connectionString: "postgres://unused" }, RELAY_POSTGRES_SHARD_ID: "next-1" },
  batchBody("batch-stale"), { database, async wake() {
    return { matched: 0, delivered: 0, owners: 0, healed: false, deliverable: false };
  } });
  assert.equal(locks.length, 2);
  assert.equal(updates.length, 0);
  assert.equal(result.daemon.status, "online");
  assert.equal(result.stale, undefined);
});

test("a wake Runtime answered with no owner marks that connection offline", async () => {
  const { database, updates, locks } = batchDatabase();
  const result = await machineDaemonCommand({
    RELAY_POSTGRES: { connectionString: "postgres://unused" }, RELAY_POSTGRES_SHARD_ID: "next-1" },
  batchBody("batch-offline"), { database, async wake() {
    return { matched: 0, delivered: 0, owners: 0, healed: false, deliverable: false };
  } });
  assert.equal(locks.length, 2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].values[3], "offline");
  assert.equal(updates[0].values[6], 0);
  assert.equal(result.daemon.status, "offline");
});

function batchBody(commandId) {
  const commandRows = [1, 2, 3].map((index) => ({
    command_id: `control-${index}`, commandType: "spawn",
    payload: { type: "machine_spawn_agent", requestId: `control-${index}`,
      spaceId: "space-1", runId: `run-${index}`, instanceId: `instance-${index}`,
      executionKey: `execution-${index}`, channelId: "channel-1" },
  }));
  return { commandId, action: "issue_batch", ownerUserId: "user-1",
    ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1",
    daemonId: "machine-daemon:user-1:machine-1:host-1",
    payload: {}, metadata: {}, capabilities: [], principal: { kind: "user", id: "user-1" },
    commands: commandRows.map((row) => ({ controlId: row.command_id, commandType: row.commandType,
      payload: row.payload })) };
}

function batchDatabase(epochForLock = () => 1) {
  const updates = [];
  const locks = [];
  const commandRows = [1, 2, 3].map((index) => ({
    command_id: `control-${index}`, owner_user_id: "user-1", machine_id: "machine-1",
    hostname: "host-1", command_type: "spawn", status: "pending", result_json: null,
    created_at: new Date("2026-09-05T00:00:00.000Z"),
    payload_json: { type: "machine_spawn_agent", requestId: `control-${index}`,
      spaceId: "space-1", runId: `run-${index}`, instanceId: `instance-${index}`,
      executionKey: `execution-${index}`, channelId: "channel-1" },
  }));
  const database = { cacheMode: "disabled", async transaction(_context, callback) {
    return callback({ async query(query) {
      if (query.name === "machine_control_daemon_update_v3") updates.push(query);
      if (query.name === "machine_control_daemon_lock_v1") locks.push(query);
      if (query.name === "machine_control_daemon_lock_v1" ||
          query.name === "machine_control_daemon_update_v3") {
        return [{ daemon_id: "machine-daemon:user-1:machine-1:host-1",
          owner_user_id: "user-1", owner_email: "one@example.com", machine_id: "machine-1",
          hostname: "host-1", status: "online", capabilities_json: [], metadata_json: {},
          connection_epoch: query.name === "machine_control_daemon_lock_v1" ? epochForLock() : 1,
          version: 2, created_at: new Date(), updated_at: new Date() }];
      }
      if (query.name === "machine_control_issue_batch_channels_v3") {
        return [{ channel_id: "channel-1", archived_at: null }];
      }
      if (query.name === "machine_control_issue_batch_v2") {
        return commandRows.map((row) => ({ command_id: row.command_id }));
      }
      if (query.name === "machine_control_issue_batch_read_v1") return commandRows;
      if (query.name === "machine_control_run_routes_batch_v2") {
        return commandRows.map((row) => ({ run_id: row.payload_json.runId }));
      }
      return [];
    } });
  } };
  return { database, updates, locks };
}
