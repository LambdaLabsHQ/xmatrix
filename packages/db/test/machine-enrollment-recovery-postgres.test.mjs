import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { historicalDaemonIds } from "./machine-identity.fixture.mjs";
import { PostgresMachineControlRepository } from "../dist/index.js";


integration("pre-SHA enrollment recovery preserves fences, rolls back conflicts and serializes retries", async () => {
  const fixture = await isolatedPostgres("enroll", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const ownerUserId = "owner", machineId = `machine:${"a".repeat(64)}`, hostId = "Workstation";
    const { oldId, daemonId } = historicalDaemonIds(ownerUserId, machineId, hostId);
    const input = { commandId: "historical-enrollment", action: "enroll", ownerUserId,
      ownerEmail: "owner@example.test", machineId, hostId, daemonId: oldId, metadata: {}, capabilities: [],
      payload: { source: "credential-issuance" }, principal: { kind: "user", id: ownerUserId } };
    await controls.command(input);
    await client.query("UPDATE data.machine_daemons SET connection_epoch=19 WHERE daemon_id=$1", [oldId]);
    await client.query(`INSERT INTO data.machine_daemon_activations
      (daemon_id,transaction_id,transaction_nonce_sha256,artifact_sha256,source_connection_epoch,
       provisional_connection_epoch,phase,expected_run_ids_json,expected_run_set_digest,version,created_at,updated_at)
      VALUES ($1,'activation',$2,$2,19,20,'activation_prepared','[]',$2,7,now(),now())`, [oldId, "b".repeat(64)]);
    const before = (await client.query("SELECT * FROM data.machine_daemon_activations WHERE daemon_id=$1", [oldId])).rows[0];
    // A historical receipt for another identity must roll the key movement back.
    await client.query("UPDATE data.machine_daemon_control_audit SET owner_user_id='other' WHERE command_id=$1", [input.commandId]);
    await assert.rejects(controls.command({ ...input, daemonId }), error => error.code === "idempotency_mismatch");
    assert.deepEqual((await client.query("SELECT daemon_id FROM data.machine_daemons")).rows, [{ daemon_id: oldId }]);
    assert.deepEqual((await client.query("SELECT * FROM data.machine_daemon_activations")).rows, [before]);
    await client.query("UPDATE data.machine_daemon_control_audit SET owner_user_id=$1 WHERE command_id=$2",
      [ownerUserId, input.commandId]);
    const [first, replay] = await Promise.all([controls.command({ ...input, daemonId }), controls.command({ ...input, daemonId })]);
    assert.equal(first.daemon.id, daemonId);
    assert.equal(first.connectionEpoch, 19);
    assert.equal(first.audit.recovered, true);
    assert.deepEqual(replay, first);
    assert.deepEqual((await client.query("SELECT * FROM data.machine_daemon_activations")).rows,
      [{ ...before, daemon_id: daemonId }]);
    assert.deepEqual((await client.query("SELECT daemon_id FROM data.machine_daemons")).rows, [{ daemon_id: daemonId }]);
    // Enrollment cannot bypass the preserved activation fence or start a new epoch.
    await assert.rejects(controls.command({ ...input, commandId: "connect", action: "connect", daemonId,
      principal: { kind: "machine", id: `machine-daemon:${ownerUserId}:${machineId}:${hostId}`,
        ownerUserId, machineId, hostId } }), error => error.code === "machine_daemon_activation_in_progress");
  } finally { await fixture.close(); }
});
