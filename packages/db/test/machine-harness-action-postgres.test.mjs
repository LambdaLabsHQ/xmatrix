import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresMachineControlRepository, readHarnessActionStatus, readRecentHarnessActions } from "../dist/index.js";


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

integration("a remote sign-in needs a login-capable daemon, delivers the pasted code once, and forgets it", async () => {
  const fixture = await isolatedPostgres("harness_login", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const machine = { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "login-machine",
      hostId: "login-host", daemonId: "login-daemon" };
    const principal = { kind: "machine", id: "machine-daemon:owner:login-machine:login-host",
      ownerUserId: "owner", machineId: "login-machine", hostId: "login-host" };
    const connect = capabilities => controls.command({ ...machine, commandId: randomUUID(), action: "connect",
      principal, capabilities, payload: {}, metadata: {} });
    const issue = (requestId, patch = {}) => controls.command({ ...machine, commandId: randomUUID(),
      action: "issue", principal: { kind: "user", id: "owner" }, controlId: requestId, commandType: "harness_action",
      payload: { type: "machine_harness_action", requestId, presetId: "claude", action: "login_start", ...patch } });
    const claim = connected => controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: connected.connectionEpoch, commandTypes: ["harness_action"], payload: {} });
    const id = () => `harness:${randomUUID()}`;

    await connect(["machine_harness_action_v1"]);
    await assert.rejects(issue(id()), error => error.code === "harness_action_unavailable");
    let connected = await connect(["machine_harness_action_v1", "machine_harness_login_v1"]);
    // No official headless sign-in for this preset; a code belongs to login_finish only.
    await assert.rejects(issue(id(), { presetId: "goose" }), error => error.code === "invalid_harness_action");
    await assert.rejects(issue(id(), { code: "abc" }), error => error.code === "invalid_harness_action");

    const startId = id();
    await issue(startId);
    // A daemon that lost the capability never leases a sign-in it cannot parse.
    const older = await connect(["machine_harness_action_v1"]);
    assert.equal((await claim(older)).commands.length, 0);
    connected = await connect(["machine_harness_action_v1", "machine_harness_login_v1"]);
    const started = await claim(connected);
    assert.deepEqual(started.commands.map(command => command.payload.requestId), [startId]);
    const waiting = { state: "awaiting_user", flow: "url_paste_code", verificationUri: "https://claude.com/cai/oauth/authorize?x=1" };
    await controls.command({ ...machine, commandId: randomUUID(), action: "complete", principal,
      connectionEpoch: connected.connectionEpoch, controlId: startId, eventType: "machine_harness_action_result",
      relayLease: started.commands[0].payload.relayLease, payload: { type: "machine_harness_action_result", requestId: startId,
        result: { presetId: "claude", action: "login_start", status: "succeeded", login: waiting } } });
    const startStatus = await readHarnessActionStatus(session, { requestId: randomUUID(), ownerUserId: "owner", controlId: startId });
    assert.deepEqual([startStatus.status, startStatus.result.login], ["succeeded", waiting]);

    const finishId = id();
    await issue(finishId, { action: "login_finish", code: "pasted#code" });
    const finishing = await claim(connected);
    assert.equal(finishing.commands[0].payload.code, "pasted#code");
    await controls.command({ ...machine, commandId: randomUUID(), action: "complete", principal,
      connectionEpoch: connected.connectionEpoch, controlId: finishId, eventType: "machine_harness_action_result",
      relayLease: finishing.commands[0].payload.relayLease, payload: { type: "machine_harness_action_result", requestId: finishId,
        result: { presetId: "claude", action: "login_finish", status: "succeeded", login: { state: "signed_in", flow: "url_paste_code" } } } });
    const stored = (await client.query("SELECT payload_json FROM data.machine_daemon_commands WHERE command_id=$1",
      [finishId])).rows[0].payload_json;
    assert.equal(stored.code, undefined, "a spent sign-in code is not kept");
    const finished = await readHarnessActionStatus(session, { requestId: randomUUID(), ownerUserId: "owner", controlId: finishId });
    assert.deepEqual([finished.status, finished.result.login.state], ["succeeded", "signed_in"]);
  } finally { await fixture.close(); }
});

integration("an unanswered action shows on the Machine, settles as expired, and is listed after reload", async () => {
  const fixture = await isolatedPostgres("harness_unanswered", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const machine = { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "quiet-machine",
      hostId: "quiet-host", daemonId: "quiet-daemon" };
    const principal = { kind: "machine", id: "machine-daemon:owner:quiet-machine:quiet-host",
      ownerUserId: "owner", machineId: "quiet-machine", hostId: "quiet-host" };
    const connected = await controls.command({ ...machine, commandId: randomUUID(), action: "connect", principal,
      capabilities: ["machine_harness_action_v1"], payload: {}, metadata: {} });
    const issue = (requestId, patch = {}) => controls.command({ ...machine, commandId: randomUUID(),
      action: "issue", principal: { kind: "user", id: "owner" }, controlId: requestId, commandType: "harness_action",
      payload: { type: "machine_harness_action", requestId, presetId: "codex", action: "install", ...patch } });
    const listed = async () => (await controls.list({ requestId: randomUUID(), ownerUserId: "owner" }))
      .daemons.find(daemon => daemon.machineId === machine.machineId);
    const read = controlId => readHarnessActionStatus(session, { requestId: randomUUID(), ownerUserId: "owner", controlId });

    const queuedId = `harness:${randomUUID()}`;
    await issue(queuedId);
    assert.equal((await listed()).unansweredSince, undefined, "a just-issued action is not yet evidence");
    await client.query("UPDATE data.machine_daemon_commands SET created_at=now()-interval '2 minutes',"
      + "available_at=now()-interval '2 minutes' WHERE command_id=$1", [queuedId]);
    const quiet = await listed();
    assert.equal(quiet.status, "online");
    assert.ok(quiet.unansweredSince, "unclaimed work marks an online daemon as not responding");

    // The daemon claims it, then stops renewing its lease and never answers.
    const claimed = await controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: connected.connectionEpoch, commandTypes: ["harness_action"], payload: {} });
    assert.equal(claimed.commands.length, 1);
    assert.equal((await listed()).unansweredSince, undefined);
    assert.equal((await read(queuedId)).status, "running");
    await client.query("UPDATE data.machine_daemon_commands SET lease_until=now()-interval '1 second',"
      + "created_at=now()-interval '40 minutes',expires_at=now()-interval '30 minutes' WHERE command_id=$1", [queuedId]);
    const settled = await read(queuedId);
    assert.equal(settled.status, "expired");
    assert.match(settled.error, /stopped responding/u);

    // A newer action on the same preset is the one listed; Hub's own release notices are not.
    const laterId = `harness:${randomUUID()}`;
    await issue(laterId, { action: "update" });
    const recent = await readRecentHarnessActions(session, { requestId: randomUUID(), ownerUserId: "owner",
      machineId: machine.machineId });
    assert.deepEqual(recent.map(action => [action.controlId, action.status]), [[laterId, "queued"]]);
    assert.deepEqual(await readRecentHarnessActions(session, { requestId: randomUUID(), ownerUserId: "intruder",
      machineId: machine.machineId }), []);

    // The late result still lands and replaces the settled reading.
    await controls.command({ ...machine, commandId: randomUUID(), action: "complete", principal,
      connectionEpoch: connected.connectionEpoch, controlId: queuedId, eventType: "machine_harness_action_result",
      relayLease: claimed.commands[0].payload.relayLease, payload: { type: "machine_harness_action_result", requestId: queuedId,
        result: { presetId: "codex", action: "install", status: "succeeded", exitCode: 0,
          item: { id: "codex", installed: false, probeStatus: "missing" } } } });
    assert.equal((await read(queuedId)).status, "succeeded");
  } finally { await fixture.close(); }
});

integration("a command handed out ten times and never answered fails instead of going out again", async () => {
  const fixture = await isolatedPostgres("unanswered_command", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const machine = { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "silent-machine",
      hostId: "silent-host", daemonId: "silent-daemon" };
    const principal = { kind: "machine", id: "machine-daemon:owner:silent-machine:silent-host",
      ownerUserId: "owner", machineId: "silent-machine", hostId: "silent-host" };
    const connected = await controls.command({ ...machine, commandId: randomUUID(), action: "connect",
      principal, capabilities: ["machine_harness_action_v1"], payload: {}, metadata: {} });
    const claim = () => controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: connected.connectionEpoch, commandTypes: ["harness_action"], payload: {} });
    const issue = requestId => controls.command({ ...machine, commandId: randomUUID(), action: "issue",
      principal: { kind: "user", id: "owner" }, controlId: requestId, commandType: "harness_action",
      payload: { type: "machine_harness_action", requestId, presetId: "claude", action: "update" } });
    const lapse = (requestId, attempts) => client.query(`UPDATE data.machine_daemon_commands SET status='leased',
      attempts=$2,lease_owner='silent-daemon',lease_until=now()-interval '1 second' WHERE command_id=$1`,
    [requestId, attempts]);

    const retried = `harness:${randomUUID()}`;
    await issue(retried);
    await lapse(retried, 9);
    assert.deepEqual((await claim()).commands.map(command => command.payload.requestId), [retried],
      "a lapsed lease is handed out again while deliveries remain");

    const silent = `harness:${randomUUID()}`;
    await issue(silent);
    await lapse(retried, 10);
    await lapse(silent, 10);
    assert.deepEqual((await claim()).commands, []);
    for (const requestId of [retried, silent]) {
      assert.equal((await readHarnessActionStatus(session, { requestId: randomUUID(), ownerUserId: "owner",
        controlId: requestId })).status, "failed");
    }
    const [stored] = (await client.query("SELECT status,result_json FROM data.machine_daemon_commands WHERE command_id=$1",
      [silent])).rows;
    assert.equal(stored.status, "failed");
    assert.equal(stored.result_json.ok, false);
    assert.match(stored.result_json.error, /never answered/u);
  } finally { await fixture.close(); }
});
