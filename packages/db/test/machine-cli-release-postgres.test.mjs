import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PostgresMachineControlRepository, readCliReleaseOwners, requestMachineCliUpdateCheck } from "../dist/index.js";

/** Enrolls and connects one daemon of `ownerUserId` reporting `version` with `capabilities`. */
async function connectedDaemon(controls, ownerUserId, machineChar, version, capabilities) {
  const machineId = `machine:${machineChar.repeat(64)}`, hostId = "Workstation";
  const daemonId = `daemon:${createHash("sha256").update(`${ownerUserId}\0${machineId}`).digest("hex")}`;
  const route = { ownerUserId, ownerEmail: `${ownerUserId}@example.test`, machineId, hostId, daemonId };
  const principal = { kind: "machine", id: `machine-daemon:${ownerUserId}:${machineId}:${hostId}`,
    ownerUserId, machineId, hostId };
  await controls.command({ ...route, commandId: `enroll-${machineChar}`, action: "enroll", metadata: {}, capabilities: [],
    payload: { source: "credential-issuance" }, principal: { kind: "user", id: ownerUserId } });
  await controls.command({ ...route, commandId: `connect-${machineChar}`, action: "connect", capabilities,
    metadata: { xmatrixDaemonVersion: version }, payload: {}, principal });
  return route;
}

integration("a CLI release names the owners whose online daemons on its channel are behind", async () => {
  const fixture = await isolatedPostgres("cli_release", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const capable = ["machine_cli_release_v1"];
    await connectedDaemon(controls, "behind-stable", "a", "2.2.0", capable);
    await connectedDaemon(controls, "current-stable", "b", "2.3.0", capable);
    await connectedDaemon(controls, "behind-beta", "c", "2.2.1-beta.19", capable);
    await connectedDaemon(controls, "incapable", "d", "2.1.0", ["machine_quota_probe_v2"]);
    const offline = await connectedDaemon(controls, "offline", "e", "2.0.0", capable);
    await client.query("UPDATE data.machine_daemons SET status='offline' WHERE daemon_id=$1", [offline.daemonId]);

    assert.deepEqual(await readCliReleaseOwners(session, { requestId: "stable", channel: "stable", version: "2.3.0" }),
      ["behind-stable"]);
    assert.deepEqual(await readCliReleaseOwners(session, { requestId: "dev", channel: "dev", version: "2.2.1-beta.20" }),
      ["behind-beta"]);
  } finally {
    await fixture.close();
  }
});

integration("a requested CLI update check reaches a capable daemon once a minute and records what it reports", async () => {
  const fixture = await isolatedPostgres("cli_update_check", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const check = (route, at) => requestMachineCliUpdateCheck(session, { requestId: `check-${at}`,
      ownerUserId: route.ownerUserId, machineId: route.machineId, at });
    // Reports are stamped with the Hub's clock, so requests here run on it too.
    const base = Date.now();
    const at = (seconds) => new Date(base + seconds * 1_000).toISOString();
    const capable = ["machine_cli_release_v1", "machine_cli_update_check_v1"];

    const old = await connectedDaemon(controls, "old", "a", "2.2.0", ["machine_cli_release_v1"]);
    assert.deepEqual(await check(old, at(0)), { outcome: "unsupported", daemonVersion: "2.2.0" });
    const disabled = await connectedDaemon(controls, "disabled", "b", "2.3.1", ["machine_cli_update_check_v1"]);
    assert.deepEqual(await check(disabled, at(0)), { outcome: "self_update_disabled", daemonVersion: "2.3.1" });
    const gone = await connectedDaemon(controls, "gone", "c", "2.3.1", capable);
    await client.query("UPDATE data.machine_daemons SET status=$1 WHERE daemon_id=$2", ["offline", gone.daemonId]);
    assert.deepEqual(await check(gone, at(0)), { outcome: "offline" });

    const route = await connectedDaemon(controls, "owner", "d", "2.3.1", capable);
    const first = await check(route, at(0));
    assert.equal(first.outcome, "checking");
    assert.equal(first.coalesced, false);
    assert.deepEqual(first.route, { daemonId: route.daemonId, hostId: route.hostId });
    // A second view within the minute joins the first check; nothing is sent again.
    const joined = await check(route, at(30));
    assert.equal(joined.coalesced, true);
    assert.equal(joined.route, undefined);
    assert.deepEqual(joined.cliUpdate, { state: "checking", at: at(0) });

    // The daemon reports what the check is doing; the next request in the minute returns that word.
    const { rows: [{ connection_epoch: epoch }] } = await client.query(
      "SELECT connection_epoch FROM data.machine_daemons WHERE daemon_id=$1", [route.daemonId]);
    const principal = { kind: "machine", id: `machine-daemon:owner:${route.machineId}:${route.hostId}`,
      ownerUserId: "owner", machineId: route.machineId, hostId: route.hostId };
    const report = (sequence, cliUpdate) => controls.command({ ...route, commandId: `report-${sequence}`,
      action: "report", eventType: "machine_run_snapshot", connectionEpoch: Number(epoch), metadata: {},
      capabilities: [], principal, payload: { type: "machine_run_snapshot", snapshotComplete: false,
        registryConnectionEpoch: Number(epoch), registrySequence: sequence, cliUpdate, runs: [] } });
    // The daemon's own clock is not trusted for ordering: an hour-old stamp still lands after the request.
    await report(1, { state: "installing", version: "2.3.2", at: at(-3_600) });
    const installing = (await check(route, at(40))).cliUpdate;
    assert.equal(installing.state, "installing");
    assert.equal(installing.version, "2.3.2");
    assert.ok(Date.parse(installing.at) >= base);
    await report(2, { state: "failed", error: "checksum mismatch for xmatrix-linux-x64", at: at(10) });
    assert.equal((await check(route, at(41))).cliUpdate.error, "checksum mismatch for xmatrix-linux-x64");
    // A report without its reason is no status and changes nothing.
    await report(3, { state: "failed", at: at(11) });
    assert.equal((await check(route, at(42))).cliUpdate.state, "failed");
    // After the minute a new request asks the daemon again.
    const again = await check(route, at(75));
    assert.equal(again.coalesced, false);
    assert.deepEqual(again.cliUpdate, { state: "checking", at: at(75) });
  } finally {
    await fixture.close();
  }
});
