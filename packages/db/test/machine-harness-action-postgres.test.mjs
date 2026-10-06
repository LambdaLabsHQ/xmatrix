import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresMachineControlRepository, readHarnessActionStatus } from "../dist/index.js";


integration("harness actions need the owner and a capable daemon, answer exactly, and fold the re-probe in", async () => {
  const fixture = await isolatedPostgres("harness_action", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const machine = { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "harness-machine",
      hostId: "harness-host", daemonId: "harness-daemon" };
    const principal = { kind: "machine", id: "machine-daemon:owner:harness-machine:harness-host",
      ownerUserId: "owner", machineId: "harness-machine", hostId: "harness-host" };
    const capturedAt = new Date(Date.now() - 60_000).toISOString();
    const connect = capabilities => controls.command({ ...machine, commandId: randomUUID(), action: "connect",
      principal, capabilities, payload: {}, metadata: { harnesses: { schemaVersion: 1, capturedAt, items: [
        { id: "claude", installed: true, version: "1.0.0", probeStatus: "ok" },
        { id: "goose", installed: false, probeStatus: "missing" }] } } });
    const issue = (requestId, patch = {}, user = "owner") => controls.command({ ...machine, commandId: randomUUID(),
      action: "issue", principal: { kind: "user", id: user }, controlId: requestId, commandType: "harness_action",
      payload: { type: "machine_harness_action", requestId, presetId: "claude", action: "update", ...patch } });
    const id = () => `harness:${randomUUID()}`;

    await connect([]);
    await assert.rejects(issue(id()), error => error.code === "harness_action_unavailable");
    const connected = await connect(["machine_harness_action_v1"]);
    await assert.rejects(issue(id(), {}, "intruder"), error => error.code === "forbidden");
    await assert.rejects(issue(id(), { presetId: "custom" }), error => error.code === "invalid_harness_action");
    await assert.rejects(issue(id(), { action: "purge" }), error => error.code === "invalid_harness_action");
    // No verified uninstaller for this preset; an older daemon cannot parse the action at all.
    await assert.rejects(issue(id(), { presetId: "grok", action: "uninstall" }), error => error.code === "invalid_harness_action");
    await assert.rejects(issue(id(), { action: "uninstall" }), error => error.code === "harness_action_unavailable");
    await assert.rejects(issue(id(), { command: "rm -rf /" }), error => error.code === "invalid_harness_action");

    await assert.rejects(issue(id(), { presetId: "cursor" }), error => error.code === "harness_action_unavailable");

    const requestId = id();
    await issue(requestId);
    assert.deepEqual(await readHarnessActionStatus(session, { requestId: randomUUID(), ownerUserId: "owner", controlId: requestId }),
      { controlId: requestId, presetId: "claude", action: "update", status: "queued" });
    assert.equal((await readHarnessActionStatus(session, { requestId: randomUUID(), ownerUserId: "intruder",
      controlId: requestId })).status, "missing");

    const claimed = await controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: connected.connectionEpoch, commandTypes: ["harness_action"], payload: {} });
    assert.equal(claimed.commands.length, 1);
    assert.equal((await readHarnessActionStatus(session, { requestId: randomUUID(), ownerUserId: "owner", controlId: requestId })).status, "running");
    const complete = result => controls.command({ ...machine, commandId: randomUUID(), action: "complete",
      principal, connectionEpoch: connected.connectionEpoch, controlId: requestId,
      eventType: "machine_harness_action_result", relayLease: claimed.commands[0].payload.relayLease,
      payload: { type: "machine_harness_action_result", requestId, result } });
    const result = { presetId: "claude", action: "update", status: "succeeded", exitCode: 0, outputTail: "updated\n",
      item: { id: "claude", installed: true, version: "2.0.0", probeStatus: "ok", latestVersion: "2.0.0", autoUpdate: "enabled" } };
    await assert.rejects(complete({ ...result, presetId: "codex" }), error => error.code === "machine_command_result_mismatch");
    await assert.rejects(complete({ ...result, item: { ...result.item, id: "goose" } }),
      error => error.code === "machine_command_result_mismatch");
    await complete(result);
    const status = await readHarnessActionStatus(session, { requestId: randomUUID(), ownerUserId: "owner", controlId: requestId });
    assert.equal(status.status, "succeeded");
    assert.deepEqual(status.result.item, result.item);
    const stored = (await client.query("SELECT metadata_json->'harnesses' AS h FROM data.machine_daemons WHERE daemon_id=$1",
      [machine.daemonId])).rows[0].h;
    assert.equal(stored.capturedAt, capturedAt);
    assert.deepEqual(stored.items, [result.item, { id: "goose", installed: false, probeStatus: "missing" }]);

    // A failed action reports a bounded message and leaves the inventory alone.
    const failedId = id();
    await issue(failedId, { presetId: "goose", action: "install" });
    const second = await controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: connected.connectionEpoch, commandTypes: ["harness_action"], payload: {} });
    await controls.command({ ...machine, commandId: randomUUID(), action: "complete", principal,
      connectionEpoch: connected.connectionEpoch, controlId: failedId, eventType: "machine_harness_action_result",
      relayLease: second.commands[0].payload.relayLease, payload: { type: "machine_harness_action_result", requestId: failedId,
        result: { presetId: "goose", action: "install", status: "failed", exitCode: 7, outputTail: "x".repeat(400) + "\ncurl failed" } } });
    const failed = await readHarnessActionStatus(session, { requestId: randomUUID(), ownerUserId: "owner", controlId: failedId });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "Exited with code 7: curl failed");

    // Unclaimed actions expire instead of running later.
    const lateId = id();
    await issue(lateId);
    await client.query("UPDATE data.machine_daemon_commands SET expires_at=now()-interval '1 second' WHERE command_id=$1", [lateId]);
    assert.equal((await readHarnessActionStatus(session, { requestId: randomUUID(), ownerUserId: "owner", controlId: lateId })).status, "expired");
    const none = await controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: connected.connectionEpoch, commandTypes: ["harness_action"], payload: {} });
    assert.equal(none.commands.length, 0);

    // A downgraded daemon cannot claim a Cursor update issued by a safe daemon.
    await connect(["machine_harness_action_v1", "machine_harness_cursor_launcher_v2"]);
    const cursorId = id();
    await issue(cursorId, { presetId: "cursor" });
    const old = await connect(["machine_harness_action_v1"]);
    const blocked = await controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: old.connectionEpoch, commandTypes: ["harness_action"], payload: {} });
    assert.equal(blocked.commands.length, 0);
    const safe = await connect(["machine_harness_action_v1", "machine_harness_cursor_launcher_v2"]);
    const allowed = await controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: safe.connectionEpoch, commandTypes: ["harness_action"], payload: {} });
    assert.equal(allowed.commands.length, 1);
    assert.equal(allowed.commands[0].payload.requestId, cursorId);

    // Likewise, a downgraded daemon never leases an uninstall it cannot parse.
    const uninstallId = id();
    await connect(["machine_harness_action_v1", "machine_harness_uninstall_v2"]);
    await issue(uninstallId, { action: "uninstall" });
    const older = await connect(["machine_harness_action_v1"]);
    assert.equal((await controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: older.connectionEpoch, commandTypes: ["harness_action"], payload: {} })).commands.length, 0);
    const capable = await connect(["machine_harness_action_v1", "machine_harness_uninstall_v2"]);
    const leased = await controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: capable.connectionEpoch, commandTypes: ["harness_action"], payload: {} });
    assert.deepEqual(leased.commands.map(command => command.payload.requestId), [uninstallId]);
  } finally { await fixture.close(); }
});
