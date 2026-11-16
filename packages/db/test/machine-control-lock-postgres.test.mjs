import assert from "node:assert/strict";
import { createAuthorityDatabase, databaseFailureEvidence, PostgresMachineControlRepository } from "../dist/index.js";
import { integration, isolatedPostgres, postgresDiagnosticClients } from "./postgres-database.fixture.mjs";

// HUB-BJ waits on the Machine advisory scope before any row query. Existing
// Channel/head lock tests cannot retain the holder of this command boundary.
integration("a blocked Machine report retains its scope holder without changing rejection or replay", async () => {
  const fixture = await isolatedPostgres("machine_scope_lock");
  const holder = fixture.client;
  const diagnostics = postgresDiagnosticClients();
  const observations = [];
  const database = createAuthorityDatabase({ connectionString: fixture.url.toString(), shardId: "shard-0",
    applicationName: "xmatrix-hub-machine-control", lockTimeoutMs: 1500,
    sessionObserver: point => observations.push(point), clientFactory: diagnostics.clientFactory });
  const controls = new PostgresMachineControlRepository(database);
  const route = { ownerUserId: "private-owner", ownerEmail: "private@example.test",
    machineId: `machine:${"a".repeat(64)}`, hostId: "private-host", daemonId: "private-daemon" };
  const principal = { kind: "machine", id: `machine-daemon:${route.ownerUserId}:${route.machineId}`,
    ownerUserId: route.ownerUserId, machineId: route.machineId };
  const report = sequence => controls.command({ ...route, commandId: `private-report-${sequence}`,
    action: "report", eventType: "machine_run_snapshot", connectionEpoch: 1, metadata: {}, capabilities: [],
    principal, payload: { type: "machine_run_snapshot", snapshotComplete: false,
      registryConnectionEpoch: 1, registrySequence: sequence, runs: [] } });
  try {
    await controls.command({ ...route, commandId: "private-enroll", action: "enroll", metadata: {},
      capabilities: [], payload: { source: "credential-issuance" }, principal: { kind: "user", id: route.ownerUserId } });
    await controls.command({ ...route, commandId: "private-connect", action: "connect", metadata: {},
      capabilities: [], payload: {}, principal });
    const before = (await holder.query("SELECT to_jsonb(d) AS value FROM data.machine_daemons d")).rows;
    for (const sequence of [1, 2]) {
      diagnostics.unavailable = sequence === 2;
      await holder.query("BEGIN; SET LOCAL application_name='xmatrix-hub-machine-control machine-control.claim'");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('machine-control:'||$1||':'||$2,0))",
        [route.ownerUserId, route.machineId]);
      await assert.rejects(report(sequence), error => {
        assert.equal(error.code, "55P03", "the answered lock rejection is unchanged");
        const [evidence] = databaseFailureEvidence(error);
        assert.equal(evidence.operation, "machine-control.report");
        assert.equal(evidence.queryName, "machine_control_scope_lock_v2");
        assert.equal(evidence.lockWait?.status, diagnostics.unavailable ? "unavailable" : "sampled");
        if (!diagnostics.unavailable) {
          assert.equal(evidence.lockWait.waiter.owner, "op:machine-control.report");
          assert.equal(evidence.lockWait.waiter.wait, "Lock");
          assert.equal(evidence.lockWait.blockers.length, 1);
          assert.equal(evidence.lockWait.blockers[0].owner, "op:machine-control.claim");
          assert.equal(evidence.lockWait.blockers[0].state, "idle in transaction");
          assert.equal(evidence.lockWait.blockers[0].wait, "Client");
          assert.ok(evidence.lockWait.blockers[0].ageMs > 0);
        }
        assert.doesNotMatch(JSON.stringify(evidence), /private|SELECT|postgres:\/\//u);
        return true;
      });
      await holder.query("ROLLBACK");
      assert.deepEqual((await holder.query("SELECT to_jsonb(d) AS value FROM data.machine_daemons d")).rows, before,
        "a rejected report changes no daemon state");
    }
    assert.equal(observations.filter(point => point.operation === "machine-control.report").length, 2,
      "each rejected command runs once");
    assert.equal(diagnostics.attempts, 2, "one bounded diagnostic attempt per blocked command");
    diagnostics.unavailable = false;
    assert.equal((await report(3)).connectionEpoch, 1, "the released scope accepts the next report");
    assert.equal(diagnostics.attempts, 2, "uncontended commands open no diagnostic connection");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await fixture.close();
  }
});

// Every daemon command locks its daemon row, and the row's metadata is
// kilobytes of harness inventory. Only a connection hands the daemon its own
// record; a report, claim or renewal never reads the metadata back.
integration("daemon commands lock their row without its metadata; a connection still gets the whole record", async () => {
  const fixture = await isolatedPostgres("machine_lock_bytes");
  const observations = [];
  const database = createAuthorityDatabase({ connectionString: fixture.url.toString(), shardId: "shard-0",
    applicationName: "xmatrix-hub-machine-control", observer: point => observations.push(point) });
  const controls = new PostgresMachineControlRepository(database);
  const route = { ownerUserId: "owner", ownerEmail: "owner@example.test",
    machineId: `machine:${"b".repeat(64)}`, hostId: "host", daemonId: "daemon" };
  const principal = { kind: "machine", id: `machine-daemon:${route.ownerUserId}:${route.machineId}`,
    ownerUserId: route.ownerUserId, machineId: route.machineId };
  const inventory = { capturedAt: "2026-11-04T00:00:00.000Z", items: [{ id: "x".repeat(65_536) }] };
  try {
    await controls.command({ ...route, commandId: "enroll", action: "enroll", metadata: {},
      capabilities: [], payload: { source: "credential-issuance" }, principal: { kind: "user", id: route.ownerUserId } });
    await controls.command({ ...route, commandId: "connect", action: "connect", metadata: {},
      capabilities: [], payload: {}, principal });
    await fixture.client.query(`UPDATE data.machine_daemons
      SET metadata_json=metadata_json||jsonb_build_object('harnesses',$1::jsonb)`, [JSON.stringify(inventory)]);
    const connected = await controls.command({ ...route, commandId: "reconnect", action: "connect", metadata: {},
      capabilities: [], payload: {}, principal });
    assert.equal(connected.daemon.metadata.harnesses.items[0].id.length, 65_536, "a connection gets its whole record");
    observations.length = 0;
    await controls.command({ ...route, commandId: "report", action: "report", eventType: "machine_run_snapshot",
      connectionEpoch: Number(connected.connectionEpoch), metadata: {}, capabilities: [], principal,
      payload: { type: "machine_run_snapshot", snapshotComplete: false, registryConnectionEpoch: 1,
        registrySequence: 1, runs: [] } });
    const lock = observations.find(point => point.queryName.startsWith("machine_control_daemon_lock_"));
    assert.ok(lock, "the report locks its daemon row");
    assert.ok(lock.resultBytes > 0 && lock.resultBytes < 2048,
      `the report's lock returned ${lock.resultBytes} bytes for a daemon with 64 KB of inventory`);
  } finally {
    await fixture.close();
  }
});
