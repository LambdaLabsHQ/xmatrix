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

integration("release targets are daemons whose switch is on and whose installed version is not the latest", async () => {
  const fixture = await isolatedPostgres("harness_release", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const { route, principal } = await enrolledDaemon(controls, "d");
    const { ownerUserId, machineId, daemonId } = route;
    await controls.command({ ...route, commandId: "connect", action: "connect", principal, payload: {},
      capabilities: ["machine_harness_inventory_v1", "machine_harness_release_v1"],
      metadata: { xmatrixDaemonVersion: "0.16.600", harnesses: { schemaVersion: 1, capturedAt: new Date().toISOString(),
        items: [
          // Seeing the latest version is not installing it: still a target.
          { id: "claude", installed: true, version: "1.0.0", probeStatus: "ok", latestVersion: "2.0.0", autoUpdate: "enabled" },
          { id: "cursor", installed: true, version: "2026.10.01", probeStatus: "ok", autoUpdate: "enabled" },
          { id: "codex", installed: true, version: "0.1.0", probeStatus: "ok", autoUpdate: "disabled" },
        ] } } });
    const { hostname } = (await client.query(
      "SELECT hostname FROM data.machine_daemons WHERE daemon_id=$1", [daemonId])).rows[0];
    const read = (...releases) => readHarnessReleaseTargets(session, { requestId: `release:${releases.length}`, releases });
    const target = { presetId: "claude", ownerUserId, ownerEmail: "owner@example.test", machineId,
      hostId: hostname ?? "", daemonId };

    assert.deepEqual(await read({ presetId: "claude", version: "2.0.0" }), [target]);
    assert.deepEqual(await read({ presetId: "claude", version: "1.0.0" }), []);
    // A switch that is off is never a target, and a preset the daemon lacks names none.
    assert.deepEqual(await read({ presetId: "codex", version: "9.0.0" }, { presetId: "claude", version: "2.0.0" },
      { presetId: "gemini", version: "1.0.0" }), [target]);
    // A preset without a registry has no version to compare.
    assert.deepEqual(await read({ presetId: "cursor" }), [{ ...target, presetId: "cursor" }]);
    assert.deepEqual(await read(), []);
    // Every watched preset at once stays within the client's result bound.
    const many = Array.from({ length: 40 }, (_, index) => ({ presetId: `preset-${index}`, version: "1.0.0" }));
    assert.deepEqual(await read(...many, { presetId: "claude", version: "2.0.0" }), [target]);
  } finally { await fixture.close(); }
});

integration("release targets probe the release notices, not a Machine's command history", async () => {
  const fixture = await isolatedPostgres("harness_release_index", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const { route, principal } = await enrolledDaemon(controls, "e");
    const { ownerUserId, machineId } = route;
    await controls.command({ ...route, commandId: "connect", action: "connect", principal, payload: {},
      capabilities: ["machine_harness_inventory_v1", "machine_harness_release_v1"],
      metadata: { xmatrixDaemonVersion: "0.16.600", harnesses: { schemaVersion: 1, capturedAt: new Date().toISOString(),
        items: [{ id: "claude", installed: true, version: "1.0.0", probeStatus: "ok", autoUpdate: "enabled" }] } } });
    // Closed history dominates the table: a busy Machine has thousands of
    // older release notices, none of them inside the repeat interval.
    await client.query(`INSERT INTO data.machine_daemon_commands
        (command_id,owner_user_id,machine_id,command_type,payload_json,status,attempts,version,created_at,updated_at)
      SELECT 'history-'||n,$1,$2,'harness_action',
        jsonb_build_object('presetId','claude','action','release'),'completed',1,1,
        now()-interval '30 days',now()-interval '30 days'
      FROM generate_series(1,40000) n`, [ownerUserId, machineId]);
    await client.query("ANALYZE data.machine_daemon_commands");
    const query = `SELECT
        release.preset_id,target.owner_user_id,target.owner_email,target.machine_id,target.hostname,target.daemon_id
        FROM unnest($2::text[],$3::text[]) WITH ORDINALITY AS release(preset_id,version,position)
        CROSS JOIN LATERAL (SELECT
          daemon.owner_user_id,daemon.owner_email,daemon.machine_id,daemon.hostname,daemon.daemon_id
          FROM data.machine_daemons daemon
          WHERE daemon.status='online' AND daemon.capabilities_json ? $1
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(daemon.metadata_json->'harnesses'->'items')='array'
                  THEN daemon.metadata_json->'harnesses'->'items' ELSE '[]'::jsonb END) item
              WHERE item->>'id'=release.preset_id AND item->'installed'='true'::jsonb
                AND item->>'autoUpdate'='enabled'
                AND (release.version='' OR item->>'version' IS DISTINCT FROM release.version))
            AND NOT EXISTS (SELECT 1 FROM data.machine_daemon_commands command
              WHERE command.owner_user_id=daemon.owner_user_id AND command.machine_id=daemon.machine_id
                AND command.command_type='harness_action' AND command.payload_json->>'presetId'=release.preset_id
                AND command.payload_json->>'action'='release'
                AND command.created_at>clock_timestamp()-
                  (CASE WHEN release.version='' THEN $6 ELSE $4 END)::interval)
          ORDER BY daemon.daemon_id LIMIT $5) target
        ORDER BY release.position,target.daemon_id`;
    const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${query}`,
      ["machine_harness_release_v1", ["claude", "cursor"], ["2.0.0", ""], "30 minutes", 500, "24 hours"]))
      .rows[0]["QUERY PLAN"][0].Plan;
    const nodes = function* (node) { yield node; for (const child of node.Plans ?? []) yield* nodes(child); };
    const commands = [...nodes(plan)].filter(node => node["Relation Name"] === "machine_daemon_commands");
    assert.deepEqual([...new Set(commands.map(node => node["Index Name"] ?? node["Node Type"]))],
      ["machine_daemon_commands_harness_release_idx"],
      "reading release targets must not scan a Machine's command history");
  } finally { await fixture.close(); }
});
