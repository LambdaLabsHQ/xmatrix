import assert from "node:assert/strict";
import test from "node:test";

import { machineDaemonCommand } from "../src/machines.ts";

test("PostgreSQL Machine issue_batch wakes once after its transaction commits", async () => {
  const wakes = [];
  const commandRows = [1, 2, 3].map((index) => ({
    command_id: `control-${index}`, owner_user_id: "user-1", machine_id: "machine-1",
    hostname: "host-1", command_type: "spawn", status: "pending", result_json: null,
    created_at: new Date("2026-09-05T00:00:00.000Z"),
    payload_json: { type: "machine_spawn_agent", requestId: `control-${index}`,
      spaceId: "space-1",
      runId: `run-${index}`, instanceId: `instance-${index}`,
      executionKey: `execution-${index}`, channelId: "channel-1" },
  }));
  const daemon = { daemon_id: "machine-daemon:user-1:machine-1:host-1",
    owner_user_id: "user-1", owner_email: "one@example.com", machine_id: "machine-1",
    hostname: "host-1", status: "online", capabilities_json: [], metadata_json: {},
    connection_epoch: 1, version: 2, created_at: new Date(), updated_at: new Date() };
  const database = { cacheMode: "disabled", async transaction(_context, callback) {
    return callback({ async query(query) {
      if (query.name === "machine_control_daemon_lock_v1" ||
          query.name === "machine_control_daemon_update_v2") return [daemon];
      if (query.name === "machine_control_issue_batch_channels_v3") {
        return [{ channel_id: "channel-1", archived_at: null }];
      }
      if (query.name === "machine_control_issue_batch_v1") {
        return commandRows.map((row) => ({ command_id: row.command_id }));
      }
      if (query.name === "machine_control_issue_batch_read_v1") return commandRows;
      if (query.name === "machine_control_run_routes_batch_v2") {
        return commandRows.map((row) => ({ run_id: row.payload_json.runId }));
      }
      return [];
    } });
  } };
  const body = { commandId: "batch-1", action: "issue_batch", ownerUserId: "user-1",
    ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1",
    payload: {}, metadata: {}, capabilities: [], principal: { kind: "user", id: "user-1" },
    commands: commandRows.map((row) => ({ controlId: row.command_id, commandType: "spawn",
      payload: row.payload_json })) };
  await machineDaemonCommand({
    RELAY_POSTGRES: { connectionString: "postgres://unused" }, RELAY_POSTGRES_SHARD_ID: "next-1" },
  body, { database, async wake(input, result) { wakes.push({ input, result }); } });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].input.action, "issue_batch");
  assert.equal(wakes[0].result.commands.length, 3);
});
