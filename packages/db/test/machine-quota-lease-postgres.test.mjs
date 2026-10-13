import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import { PostgresMachineControlRepository } from "../dist/index.js";

integration("quota probes get a bounded execution window at claim without admitting expired work or stale results", async () => {
  const fixture = await isolatedPostgres("quota_lease", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const machine = { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "quota-machine",
      hostId: "quota-host", daemonId: "quota-daemon" };
    const principal = { kind: "machine", id: "machine-daemon:owner:quota-machine:quota-host",
      ownerUserId: machine.ownerUserId, machineId: machine.machineId, hostId: machine.hostId };
    const connected = await controls.command({ ...machine, commandId: randomUUID(), action: "connect",
      principal, capabilities: ["machine_quota_probe_v2"], payload: {}, metadata: {} });
    const target = { targetId: "registration:codex", configurationDigest: "a".repeat(64) };
    const issue = async () => {
      const requestId = `quota:${randomUUID()}`;
      await controls.command({ ...machine, commandId: randomUUID(), action: "issue",
        principal: { kind: "user", id: "owner" }, controlId: requestId, commandType: "quota_probe",
        payload: { type: "machine_quota_probe", requestId,
          probe: { requestId, connectionEpoch: connected.connectionEpoch, targets: [target] } } });
      return requestId;
    };
    const claim = () => controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: connected.connectionEpoch, commandTypes: ["quota_probe"], payload: {} });
    const complete = (command, epoch = connected.connectionEpoch) => controls.command({ ...machine,
      commandId: randomUUID(), action: "complete", principal, connectionEpoch: epoch,
      controlId: command.controlId, eventType: "machine_quota_probe_result", relayLease: command.payload.relayLease,
      payload: { type: "machine_quota_probe_result", requestId: command.controlId,
        probe: { requestId: command.controlId, connectionEpoch: connected.connectionEpoch,
          results: [{ ...target, status: "unavailable", reason: "timeout" }] } } });

    const delayedId = await issue();
    // The production case spent eight of its fifteen seconds reaching admission.
    await client.query(`UPDATE data.machine_daemon_commands SET created_at=clock_timestamp()-interval '8 seconds',
      expires_at=clock_timestamp()+interval '7 seconds' WHERE command_id=$1`, [delayedId]);
    const expiredId = await issue();
    await client.query("UPDATE data.machine_daemon_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE command_id=$1", [expiredId]);
    const claimed = await claim();
    assert.deepEqual(claimed.commands.map(command => command.controlId), [delayedId], "expired intake is never executed");
    const window = (await client.query(`SELECT extract(epoch FROM (expires_at-clock_timestamp())) AS remaining
      FROM data.machine_daemon_commands WHERE command_id=$1`, [delayedId])).rows[0];
    assert.ok(Number(window.remaining) > 10 && Number(window.remaining) <= 15,
      "admission must leave the full ten-second daemon probe budget plus result delivery time");
    await complete(claimed.commands[0]);
    assert.equal((await client.query("SELECT status FROM data.machine_daemon_commands WHERE command_id=$1", [delayedId])).rows[0].status, "completed");

    const lateId = await issue();
    const late = (await claim()).commands[0];
    await client.query("UPDATE data.machine_daemon_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE command_id=$1", [lateId]);
    await assert.rejects(complete(late), error => error.code === "machine_command_stale_lease", "the execution window stays bounded");
    assert.equal((await client.query("SELECT result_json FROM data.machine_daemon_commands WHERE command_id=$1", [lateId])).rows[0].result_json, null);

    const fencedId = await issue();
    const fenced = (await claim()).commands[0];
    const reconnected = await controls.command({ ...machine, commandId: randomUUID(), action: "connect",
      principal, capabilities: ["machine_quota_probe_v2"], payload: {}, metadata: {} });
    await assert.rejects(complete(fenced, reconnected.connectionEpoch), error => error.code === "machine_command_result_mismatch",
      "another daemon epoch cannot publish a quota reading");
    assert.equal((await client.query("SELECT result_json FROM data.machine_daemon_commands WHERE command_id=$1", [fencedId])).rows[0].result_json, null);
  } finally { await fixture.close(); }
});
