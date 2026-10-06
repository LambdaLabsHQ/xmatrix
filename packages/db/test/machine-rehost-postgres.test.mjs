import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { adoptLegacyMachineIds, PostgresMachineControlRepository } from "../dist/index.js";

// A host-derived Machine keeps one daemon whatever its host name is called.
// A connection from the renamed host moves the Machine's host-keyed facts to
// the new name, a process still using an old epoch is fenced, and work
// the owner issues follows the Machine to the host it last connected from.

const OWNER = "alice";
const D = `machine:${"b".repeat(64)}`;
const OTHER = `machine:${"c".repeat(64)}`;
const daemonId = machine => `daemon:${createHash("sha256").update(`${OWNER}\0${machine}`).digest("hex")}`;
const principal = (machine, host) => ({ kind: "machine", id: `machine-daemon:${OWNER}:${machine}:${host}`,
  ownerUserId: OWNER, machineId: machine, hostId: host });

integration("a derived Machine follows its renamed host with one daemon", async () => {
  const fixture = await isolatedPostgres("machine_rehost", { shard: true });
  const { session, run } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const connect = (machine, host) => controls.command({ ownerUserId: OWNER, ownerEmail: "alice@example.test",
      machineId: machine, hostId: host, daemonId: daemonId(machine), commandId: randomUUID(), action: "connect",
      principal: principal(machine, host), capabilities: ["machine_quota_probe_v2"], payload: {}, metadata: {} });

    const first = await connect(D, "old-host");
    await connect(OTHER, "old-host");
    const facts = async (machine) => ({
      daemons: await run(`SELECT daemon_id,hostname FROM data.machine_daemons WHERE machine_id=$1`, [machine]),
      routes: await run(`SELECT run_id,hostname FROM data.machine_run_routes WHERE machine_id=$1 ORDER BY run_id`, [machine]),
      heads: await run(`SELECT hostname,channel_id FROM data.machine_run_snapshot_heads WHERE machine_id=$1
        ORDER BY hostname,channel_id`, [machine]),
    });
    for (const [machine, run_id] of [[D, "run-d"], [OTHER, "run-other"]]) {
      await run(`INSERT INTO data.machine_run_routes (run_id,owner_user_id,machine_id,hostname,channel_id,execution_key,
        created_at,updated_at) VALUES ($1,$2,$3,'old-host','ch-1','exec-1',now(),now())`, [run_id, OWNER, machine]);
    }
    // The causal head is unique by Machine and Channel; hostname is an observation.
    for (const [host, channel] of [["old-host", "ch-1"], ["old-host", "ch-2"]]) {
      await run(`INSERT INTO data.machine_run_snapshot_heads (owner_user_id,machine_id,hostname,channel_id,
        connection_epoch,registry_sequence,captured_at,updated_at) VALUES ($1,$2,$3,$4,1,1,now(),now())`,
      [OWNER, D, host, channel]);
    }

    const second = await connect(D, "new-host");
    assert.ok(second.connectionEpoch > first.connectionEpoch);
    assert.deepEqual(await facts(D), {
      daemons: [{ daemon_id: daemonId(D), hostname: "new-host" }],
      routes: [{ run_id: "run-d", hostname: "old-host" }],
      heads: [{ hostname: "old-host", channel_id: "ch-1" }, { hostname: "old-host", channel_id: "ch-2" }],
    });
    // Another Machine of the same owner on the same old host name is untouched.
    assert.deepEqual((await facts(OTHER)).routes, [{ run_id: "run-other", hostname: "old-host" }]);

    // A replaced process is fenced by its epoch, regardless of its hostname.
    await assert.rejects(controls.command({ ownerUserId: OWNER, ownerEmail: "alice@example.test", machineId: D,
      hostId: "old-host", daemonId: daemonId(D), commandId: randomUUID(), action: "report",
      connectionEpoch: first.connectionEpoch, principal: principal(D, "old-host"), eventType: "machine_heartbeat",
      payload: {} }), error => error.code === "machine_daemon_stale_epoch");

    // Hostname mismatch in the live epoch is an observation, never a permission boundary.
    const liveReport = await controls.command({ ownerUserId: OWNER, ownerEmail: "alice@example.test", machineId: D,
      hostId: "old-host", daemonId: daemonId(D), commandId: randomUUID(), action: "report",
      connectionEpoch: second.connectionEpoch, principal: principal(D, "old-host"), eventType: "machine_heartbeat",
      payload: {} });
    assert.equal(liveReport.connectionEpoch, second.connectionEpoch);
    assert.equal(liveReport.daemon.hostname, "new-host");
    await assert.rejects(controls.command({ ownerUserId: OWNER, ownerEmail: "alice@example.test", machineId: D,
      hostId: "new-host", daemonId: daemonId(D), commandId: randomUUID(), action: "report",
      connectionEpoch: second.connectionEpoch, principal: principal(OTHER, "new-host"), eventType: "machine_heartbeat",
      payload: {} }), error => error.code === "forbidden");

    // New credentials contain no hostname; authority retains the observed value from the exact Machine.
    const hostlessReport = await controls.command({ ownerUserId: OWNER, ownerEmail: "alice@example.test", machineId: D,
      daemonId: daemonId(D), commandId: randomUUID(), action: "report", connectionEpoch: second.connectionEpoch,
      principal: { kind: "machine", id: `machine-daemon:${OWNER}:${D}`, ownerUserId: OWNER, machineId: D },
      eventType: "machine_heartbeat", payload: {} });
    assert.equal(hostlessReport.daemon.hostname, "new-host");
    await assert.rejects(controls.command({ ownerUserId: OWNER, ownerEmail: "alice@example.test", machineId: D,
      daemonId: daemonId(D), commandId: randomUUID(), action: "report", connectionEpoch: first.connectionEpoch,
      principal: { kind: "machine", id: `machine-daemon:${OWNER}:${D}`, ownerUserId: OWNER, machineId: D },
      eventType: "machine_heartbeat", payload: {} }), error => error.code === "machine_daemon_stale_epoch");

    // Owner-issued work addressed by the old host name reaches the Machine where it now is.
    const probe = { requestId: "probe-control", connectionEpoch: second.connectionEpoch,
      targets: [{ targetId: "registration:codex", configurationDigest: "a".repeat(64) }] };
    const issued = await controls.command({ ownerUserId: OWNER, ownerEmail: "alice@example.test", machineId: D,
      hostId: "old-host", daemonId: daemonId(D), commandId: randomUUID(), action: "issue",
      principal: { kind: "user", id: OWNER }, controlId: probe.requestId, commandType: "quota_probe",
      payload: { type: "machine_quota_probe", requestId: probe.requestId, probe } });
    assert.equal(issued.daemon.hostId, "new-host");
    assert.deepEqual(await run(`SELECT hostname FROM data.machine_daemon_commands WHERE machine_id=$1`, [D]),
      [{ hostname: "new-host" }]);
  } finally { await fixture.close(); }
});

integration("rehost folds a sibling daemon that already occupies the destination host", async () => {
  const fixture = await isolatedPostgres("machine_rehost_sibling", { shard: true });
  const { session, run } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const canonical = daemonId(D);
    const sibling = "daemon:5f728608";
    await controls.command({ ownerUserId: OWNER, ownerEmail: "alice@example.test", machineId: D, hostId: "cursor",
      daemonId: canonical, commandId: randomUUID(), action: "connect", principal: principal(D, "cursor"),
      capabilities: [], payload: {}, metadata: {} });
    await run(`INSERT INTO data.machine_daemons (daemon_id,owner_user_id,owner_email,machine_id,hostname,status,
      capabilities_json,metadata_json,connection_epoch,version,created_at,updated_at)
      SELECT $1,owner_user_id,owner_email,machine_id,'grok-bot-vm','offline',capabilities_json,metadata_json,
      connection_epoch,version,created_at,updated_at FROM data.machine_daemons WHERE daemon_id=$2`, [sibling, canonical]);
    const digest = "a".repeat(64);
    await run(`INSERT INTO data.machine_daemon_activations (daemon_id,transaction_id,transaction_nonce_sha256,
      artifact_sha256,source_connection_epoch,provisional_connection_epoch,phase,expected_run_ids_json,
      expected_run_set_digest,version,created_at,updated_at)
      VALUES ($1,'txn-sibling',$2,$2,1,2,'aborted','[]'::jsonb,$2,1,now(),now())`, [sibling, digest]);
    await run(`INSERT INTO data.machine_daemon_control_audit
      (command_id,daemon_id,owner_user_id,action,payload_json,created_at)
      VALUES ('enroll-dual',$1,$2,'enroll','{}'::jsonb,now())`, [sibling, OWNER]);
    for (const [runId, host] of [["run-old", "cursor"], ["run-live", "grok-bot-vm"]]) {
      await run(`INSERT INTO data.machine_run_routes (run_id,owner_user_id,machine_id,hostname,channel_id,execution_key,
        created_at,updated_at) VALUES ($1,$2,$3,$4,'ch-1','exec-1',now(),now())`, [runId, OWNER, D, host]);
    }
    for (const [host, channel] of [["cursor", "ch-1"], ["cursor", "ch-2"]]) {
      await run(`INSERT INTO data.machine_run_snapshot_heads (owner_user_id,machine_id,hostname,channel_id,
        connection_epoch,registry_sequence,captured_at,updated_at) VALUES ($1,$2,$3,$4,1,1,now(),now())`,
      [OWNER, D, host, channel]);
    }

    const enrolled = await controls.command({ ownerUserId: OWNER, ownerEmail: "alice@example.test", machineId: D,
      hostId: "grok-bot-vm", daemonId: canonical, commandId: "enroll-dual", action: "enroll",
      principal: { kind: "user", id: OWNER }, payload: { source: "credential-issuance" }, metadata: {}, capabilities: [] });
    assert.equal(enrolled.reused, true);
    assert.equal(enrolled.daemon.id, canonical);
    assert.equal(enrolled.daemon.hostId, "grok-bot-vm");
    assert.deepEqual(await run(`SELECT daemon_id,hostname FROM data.machine_daemons WHERE machine_id=$1`, [D]),
      [{ daemon_id: canonical, hostname: "grok-bot-vm" }]);
    assert.deepEqual(await run(`SELECT daemon_id FROM data.machine_daemon_control_audit WHERE command_id='enroll-dual'`),
      [{ daemon_id: canonical }]);
    assert.deepEqual(await run(`SELECT daemon_id,phase FROM data.machine_daemon_activations`),
      [{ daemon_id: canonical, phase: "aborted" }]);
    assert.deepEqual(await run(`SELECT run_id,hostname FROM data.machine_run_routes WHERE machine_id=$1 ORDER BY run_id`, [D]),
      [{ run_id: "run-live", hostname: "grok-bot-vm" }, { run_id: "run-old", hostname: "cursor" }]);
    assert.deepEqual(await run(`SELECT hostname,channel_id FROM data.machine_run_snapshot_heads WHERE machine_id=$1
      ORDER BY channel_id`, [D]),
      [{ hostname: "cursor", channel_id: "ch-1" }, { hostname: "cursor", channel_id: "ch-2" }]);
  } finally { await fixture.close(); }
});

integration("legacy daemons of several host names fold into the derived Machine's one daemon", async () => {
  const fixture = await isolatedPostgres("machine_fold", { shard: true });
  const { session, run } = fixture;
  try {
    const legacy = [["machine:11111111-1111-4111-8111-111111111111", "studio", "daemon:0000000a"],
      ["machine:22222222-2222-4222-8222-222222222222", "laptop", "daemon:0000000b"]];
    for (const [machine, host, id] of legacy) {
      await run(`INSERT INTO data.machines (owner_user_id,machine_id,name) VALUES ($1,$2,$3)`, [OWNER, machine, host]);
      await run(`INSERT INTO data.machine_daemons (daemon_id,owner_user_id,owner_email,machine_id,hostname,status,
        capabilities_json,metadata_json,connection_epoch,version,created_at,updated_at)
        VALUES ($1,$2,'alice@example.test',$3,$4,'offline','[]','{}',1,1,now(),now())`, [id, OWNER, machine, host]);
    }
    await adoptLegacyMachineIds(session, { requestId: randomUUID(), ownerUserId: OWNER, machineId: D,
      legacyMachineIds: legacy.map(([machine]) => machine), daemonId: (_owner, machine) => daemonId(machine) });
    assert.deepEqual(await run(`SELECT daemon_id,machine_id,hostname FROM data.machine_daemons WHERE owner_user_id=$1`,
      [OWNER]), [{ daemon_id: daemonId(D), machine_id: D, hostname: "studio" }]);
  } finally { await fixture.close(); }
});

integration("a minted Machine id never enrolls or connects; a host-derived one does", async () => {
  const fixture = await isolatedPostgres("machine_enroll", { shard: true });
  const { client, session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const command = (action, machine, host) => controls.command({ ownerUserId: OWNER, ownerEmail: "alice@example.test",
      machineId: machine, hostId: host, hostName: host, daemonId: `daemon:${machine.slice(-8)}:${host}`,
      commandId: randomUUID(), action,
      principal: action === "enroll" ? { kind: "user", id: OWNER } : principal(machine, host),
      payload: { source: "credential-issuance" }, metadata: {}, capabilities: [] });
    const MINTED = "machine:44444444-4444-4444-8444-444444444444";
    for (const action of ["enroll", "connect", "recover_connect"]) {
      await assert.rejects(command(action, MINTED, "studio"), error =>
        error.code === "machine_id_upgrade_required" && error.status === 426, action);
    }
    assert.deepEqual((await client.query(`SELECT machine_id FROM data.machine_daemons WHERE machine_id=$1`, [MINTED])).rows, []);
    // A host-derived Machine always enrolls.
    await command("enroll", D, "desk");
  } finally { await fixture.close(); }
});
