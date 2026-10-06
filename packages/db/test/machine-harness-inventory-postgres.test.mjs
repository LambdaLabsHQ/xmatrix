import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PostgresMachineControlRepository, readHarnessReleaseTargets } from "../dist/index.js";

/** A daemon route for one Machine, enrolled by its owner. */
async function enrolledDaemon(controls, machineChar) {
  const ownerUserId = "owner", machineId = `machine:${machineChar.repeat(64)}`, hostId = "Workstation";
  const daemonId = `daemon:${createHash("sha256").update(`${ownerUserId}\0${machineId}`).digest("hex")}`;
  const route = { ownerUserId, ownerEmail: "owner@example.test", machineId, hostId, daemonId };
  const principal = { kind: "machine", id: `machine-daemon:${ownerUserId}:${machineId}:${hostId}`,
    ownerUserId, machineId, hostId };
  await controls.command({ ...route, commandId: "enroll", action: "enroll", metadata: {}, capabilities: [],
    payload: { source: "credential-issuance" }, principal: { kind: "user", id: ownerUserId } });
  return { route, principal };
}

integration("snapshot inventories persist per connection, never regress and need the capability", async () => {
  const fixture = await isolatedPostgres("harness", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const { route, principal } = await enrolledDaemon(controls, "c");
    const { daemonId } = route;
    const base = Date.now() - 60_000;
    const at = offset => new Date(base + offset * 1_000).toISOString();
    const inventory = (capturedAt, version) => ({ schemaVersion: 1, capturedAt,
      items: [{ id: "claude", installed: true, version, probeStatus: "ok", stderr: "secret" }] });
    const stored = async () => (await client.query(
      "SELECT metadata_json->'harnesses' AS h FROM data.machine_daemons WHERE daemon_id=$1", [daemonId])).rows[0].h;
    const connect = (commandId, capabilities, harnesses) => controls.command({ ...route, commandId, action: "connect",
      capabilities, metadata: { xmatrixDaemonVersion: "0.16.600", ...(harnesses ? { harnesses } : {}) },
      payload: {}, principal });
    const report = (commandId, connectionEpoch, harnessInventory) => controls.command({ ...route, commandId,
      action: "report", eventType: "machine_run_snapshot", connectionEpoch, metadata: {}, capabilities: [], principal,
      payload: { type: "machine_run_snapshot", snapshotComplete: false, registryConnectionEpoch: connectionEpoch,
        registrySequence: Number(commandId.replace(/\D/gu, "")) || 1, harnessInventory, runs: [] } });

    // Without the capability nothing is written.
    const first = await connect("connect-1", ["machine_quota_probe_v2"]);
    await report("report-1", first.connectionEpoch, inventory(at(1), "1.0.0"));
    assert.equal(await stored(), null);

    // The cached inventory from connect is validated and stripped.
    const second = await connect("connect-2", ["machine_harness_inventory_v1"], inventory(at(2), "1.0.1"));
    assert.deepEqual((await stored()).items, [{ id: "claude", installed: true, version: "1.0.1", probeStatus: "ok" }]);

    await report("report-3", second.connectionEpoch, inventory(at(5), "2.0.0"));
    assert.equal((await stored()).items[0].version, "2.0.0");
    // An older or equal capture never replaces a fresher one.
    await report("report-4", second.connectionEpoch, inventory(at(4), "1.5.0"));
    await report("report-5", second.connectionEpoch, inventory(at(5), "1.6.0"));
    assert.equal((await stored()).items[0].version, "2.0.0");
    // An invalid inventory is dropped without failing the snapshot.
    await report("report-6", second.connectionEpoch, { schemaVersion: 2 });
    assert.equal((await stored()).items[0].version, "2.0.0");

    // A report from a superseded connection cannot write.
    const third = await connect("connect-7", ["machine_harness_inventory_v1"]);
    assert.ok(third.connectionEpoch > second.connectionEpoch);
    await report("report-8", second.connectionEpoch, inventory(at(30), "9.9.9")).catch(() => {});
    assert.notEqual((await stored())?.items?.[0]?.version, "9.9.9");
  } finally { await fixture.close(); }
});

integration("release targets read the current schema and skip daemons that already saw the version", async () => {
  const fixture = await isolatedPostgres("harness-release", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const { route, principal } = await enrolledDaemon(controls, "d");
    const { ownerUserId, machineId, daemonId } = route;
    await controls.command({ ...route, commandId: "connect", action: "connect", principal, payload: {},
      capabilities: ["machine_harness_inventory_v1", "machine_harness_release_v1"],
      metadata: { xmatrixDaemonVersion: "0.16.600", harnesses: { schemaVersion: 1, capturedAt: new Date().toISOString(),
        items: [{ id: "claude", installed: true, version: "1.0.0", probeStatus: "ok", latestVersion: "1.0.0" }] } } });
    const { hostname } = (await client.query(
      "SELECT hostname FROM data.machine_daemons WHERE daemon_id=$1", [daemonId])).rows[0];
    const read = version => readHarnessReleaseTargets(session, { requestId: `release:${version}`, presetId: "claude", version });

    assert.deepEqual(await read("2.0.0"), [{ ownerUserId, ownerEmail: "owner@example.test", machineId,
      hostId: hostname ?? "", daemonId }]);
    assert.deepEqual(await read("1.0.0"), []);
  } finally { await fixture.close(); }
});
