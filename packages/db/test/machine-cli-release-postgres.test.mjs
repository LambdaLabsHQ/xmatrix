import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PostgresMachineControlRepository, readCliReleaseOwners } from "../dist/index.js";

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
