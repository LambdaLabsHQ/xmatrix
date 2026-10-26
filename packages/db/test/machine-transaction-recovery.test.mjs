import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { ConnectivityBreaker, databaseFailureEvidence, DatabaseCommitUnknownError,
  PostgresMachineControlRepository, PostgresMachineLifecycleRepository } from "../dist/index.js";
import { wireRecoveryDatabase } from "./wire-recovery.fixture.mjs";
import { placedChannel, recordingDatabase } from "./recording-database.fixture.mjs";

const ownerUserId = "owner", machineId = "machine", hostId = "host", channelId = "channel-1";
const principal = { kind: "machine", ownerUserId, machineId };
const daemon = { daemon_id: "daemon", owner_user_id: ownerUserId, owner_email: "owner@example.test",
  machine_id: machineId, hostname: hostId, status: "enrolled", capabilities_json: [], metadata_json: {},
  connection_epoch: 1, version: 1, created_at: new Date(), updated_at: new Date() };
const report = { executionId: randomUUID(), revision: 1, sourceCount: 1, state: "running",
  startedAtMillis: Date.now(), updatedAtMillis: Date.now(), sources: [{ channelId, messageId: "message",
    sequence: 1, entityVersion: 1, bodyHash: "a".repeat(64) }] };
const commands = {
  enroll: database => new PostgresMachineControlRepository(database).command({
    commandId: "enroll", action: "enroll", ownerUserId, ownerEmail: daemon.owner_email, machineId,
    hostId, daemonId: daemon.daemon_id, payload: {}, principal: { kind: "user", id: ownerUserId } }),
  execution: database => new PostgresMachineLifecycleRepository(database).apply({
    commandId: "execution", ownerUserId, machineId, hostId, channelId, principal,
    eventType: "machine_execution_report", payload: { schemaVersion: 1, requestId: randomUUID(),
      scope: { channelId, runId: "run", instanceId: "instance", agentId: "instance",
        executionFingerprint: createHash("sha256").update("key").digest("hex") }, report } }),
};

/** Real transaction owner and driver failures; directory answers only supply routing. */
function fixture(stage, failures, breaker = new ConnectivityBreaker("shard-0")) {
  const directory = recordingDatabase(query => placedChannel(query) ?? []);
  const { database: wire, pools } = wireRecoveryDatabase(stage, failures, { shardId: "shard-0", breaker,
    phaseForQuery: text => /UPDATE\s+data.machine_daemons|INSERT INTO data.agent_message_executions/u.test(text)
      ? "write" : "sql",
    rowsForQuery: text => /FROM control.space_placement/u.test(text)
      ? [{ shard_id: "shard-0", placement_epoch: 1, state: "active", target_shard_id: null }]
      : /SELECT \* FROM data.machine_daemons|UPDATE\s+data.machine_daemons/u.test(text) ? [daemon]
      : /AS agent_name\s+FROM data.runs/u.test(text) ? [{ run_id: "run", instance_id: "instance",
        channel_instance_id: "1", metadata_json: { executionKey: "key" } }] : [],
  });
  return { pools, database: { ...wire, cacheMode: "disabled", openSession: () => wire.openSession(),
    transaction: (context, callback) => context.operation.startsWith("machine-lifecycle.")
      ? directory.transaction(context, callback) : wire.transaction(context, callback) } };
}

for (const [name, run] of Object.entries(commands)) {
  test(`${name} recovers one lost checkout, opening or write response on a fresh session (HUB-AN/AP)`, async () => {
    for (const stage of ["begin", "checkout", "write"]) {
      const failure = new Error(stage === "checkout" ? "timeout exceeded when trying to connect" : "Query read timeout");
      const { database, pools } = fixture(stage, [failure]);
      const value = await run(database);
      assert.equal(name === "enroll" ? value.daemon.id : value.status,
        name === "enroll" ? "daemon" : "source_unavailable");
      assert.equal(pools.length, 2, stage);
      assert.ok(pools.every(pool => pool.ended));
      assert.ok(!pools[0].queries.includes("COMMIT") && !pools[0].queries.includes("ROLLBACK"));
      assert.deepEqual(pools[0].releases, stage === "checkout" ? [] : [true]);
      assert.equal(pools[1].queries.at(-1), "COMMIT");
      assert.deepEqual(pools[1].releases, [false]);
    }
  });

  test(`${name} preserves both exhausted failures and never takes a third session`, async () => {
    for (const stage of ["begin", "checkout", "write"]) {
      const failure = () => new Error(stage === "checkout" ? "timeout exceeded when trying to connect" : "Query read timeout");
      const second = failure(), { database, pools } = fixture(stage, [failure(), second]);
      await assert.rejects(run(database), error => error === second);
      assert.equal(pools.length, 2);
      assert.ok(pools.every(pool => pool.ended));
      assert.deepEqual(databaseFailureEvidence(second).map(item => item.phase),
        Array(2).fill(stage === "checkout" ? "pool_checkout" : stage === "write" ? "sql" : "begin"));
    }
  });

  test(`${name} does not replay COMMIT uncertainty, answered rejections or an open breaker`, async () => {
    const lost = fixture("commit", [new Error("Query read timeout")]);
    await assert.rejects(run(lost.database), DatabaseCommitUnknownError);
    assert.equal(lost.pools.length, 1);
    assert.deepEqual(lost.pools[0].releases, [true]);
    for (const code of ["40P01", "28P01"]) {
      const failure = Object.assign(new Error("Query read timeout"), { code });
      const rejected = fixture("begin", [failure]);
      await assert.rejects(run(rejected.database), error => error === failure);
      assert.equal(rejected.pools.length, 1);
      assert.equal(rejected.pools[0].queries.at(-1), "ROLLBACK");
    }
    const breaker = new ConnectivityBreaker("shard-0");
    for (let i = 0; i < 4; i++) breaker.failure();
    const first = new Error("timeout exceeded when trying to connect"), blocked = fixture("checkout", [first], breaker);
    await assert.rejects(run(blocked.database), error => error.name === "DatabaseCircuitOpenError");
    assert.equal(blocked.pools.length, 2);
    assert.deepEqual(blocked.pools[1].queries, []);
    assert.deepEqual(databaseFailureEvidence(first).map(item => item.phase), ["pool_checkout"]);
  });
}
