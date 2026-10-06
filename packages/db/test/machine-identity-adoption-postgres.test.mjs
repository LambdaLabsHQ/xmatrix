import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MachineIdentityAdoptionError, adoptLegacyMachineIds } from "../dist/index.js";

// Two profiles on one host each minted a Machine id. Adopting both into the
// host-derived id must leave no record of the owner spelling either one, merge
// the duplicate registration and workspace, and never touch another owner.

const L1 = "machine:11111111-1111-4111-8111-111111111111";
const L2 = "machine:22222222-2222-4222-8222-222222222222";
const OTHER = "machine:33333333-3333-4333-8333-333333333333";
const D = `machine:${"a".repeat(64)}`;
const daemonId = (owner, machine, host) => `daemon:${owner}:${machine.slice(-4)}:${host}`;

integration("legacy Machine ids adopt into the host-derived id and merge on one host", async () => {
  const fixture = await isolatedPostgres("machine_adoption");
  const { client, run } = fixture;
  try {
    const limits = workspace => JSON.stringify({ workspaces: [workspace], models: ["gpt-5"], secrets: [], capabilities: [] });
    const workspace = machine => JSON.stringify([machine, "/repo"]);
    for (const [owner, machine, label, host] of [["alice", L1, "First", "studio"], ["alice", L2, "Second", "studio"],
      ["bob", OTHER, "Bob", "studio"]]) {
      await run(`INSERT INTO data.machines (owner_user_id,machine_id,name) VALUES ($1,$2,$3)`, [owner, machine, `${label} host`]);
      await run(`INSERT INTO data.machine_daemons (daemon_id,owner_user_id,owner_email,machine_id,hostname,status,
          capabilities_json,metadata_json,connection_epoch,version,created_at,updated_at)
        VALUES ($1,$2,'o@example.test',$3,$4,'offline','[]',$5::jsonb,1,1,now(),now())`,
      [daemonId(owner, machine, host), owner, machine, host, JSON.stringify({ machineFingerprint: "fp", previous: machine })]);
      await run(`INSERT INTO data.agent_registrations VALUES ($1,$2,'codex',1,now(),now())`, [owner, machine]);
      await run(`INSERT INTO data.space_agent_registrations VALUES ('space',$1,$2,'codex',$3,$4::jsonb,1,now(),now())`,
        [owner, machine, label, JSON.stringify({ workspaceReferences: [workspace(machine)], secretReferences: [] })]);
      await run(`INSERT INTO data.space_agent_registration_access (space_id,owner_user_id,machine_id,harness,
          grant_state,grant_revision,grant_execution_revision,grant_limits,policy_state,policy_revision,policy_execution_revision,policy_limits,updated_at)
        VALUES ('space',$1,$2,'codex','active',1,1,$3::jsonb,'enabled',1,1,$3::jsonb,now())`, [owner, machine, limits(workspace(machine))]);
      await run(`INSERT INTO data.workspaces (workspace_id,owner_user_id,machine_id,canonical_cwd,version,metadata_json,created_at,updated_at)
        VALUES ($1,$2,$3,'/repo',1,$4::jsonb,now(),now())`, [workspace(machine), owner, machine, JSON.stringify({ displayName: label })]);
      // Run ids are natural keys: `<channel>:<Instance ordinal>#<start>`.
      const runId = `channel:${{ First: 1, Second: 2, Bob: 3 }[label]}#1`;
      await run(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,workspace_id,status,version,metadata_json,created_at,updated_at,
          workspace_machine_id,workspace_canonical_cwd) VALUES ($1,$2,'channel',$3,'running',1,$4::jsonb,now(),now(),$5,'/repo')`,
      [runId, owner, workspace(machine), JSON.stringify({ machineId: machine, hostId: host }), machine]);
      await run(`INSERT INTO data.run_agent_registrations (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,
          allocation_id,authorization_digest,grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
        VALUES ($1,'space',$2,$3,'codex',$2,$4,repeat('a',64),1,1,1,1,$5::jsonb)`,
      [runId, owner, machine, `allocation-${label}`, limits(workspace(machine))]);
    }

    const database = { cacheMode: "disabled", transaction: async (_context, callback) => {
      await client.query("BEGIN");
      try {
        const result = await callback({ query: async ({ text, values, maxRows }) => {
          const { rows } = await client.query({ text, values });
          assert.ok(rows.length <= maxRows, `${rows.length} rows exceed ${maxRows}`);
          return rows;
        } });
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    } };
    const adopt = (legacyMachineIds, machineId = D, ownerUserId = "alice") => adoptLegacyMachineIds(database,
      { requestId: randomUUID(), ownerUserId, machineId, legacyMachineIds, daemonId });
    /** Every row in data/control that still spells an id, by table. */
    const spelling = async (id) => {
      const tables = await run(`SELECT format('%I.%I', table_schema, table_name) AS name FROM information_schema.tables
        WHERE table_schema IN ('data','control') AND table_type='BASE TABLE' AND table_name <> 'machine_identity_adoptions'`);
      const found = {};
      for (const { name: table } of tables) {
        const [{ count }] = await run(`SELECT count(*)::int AS count FROM ${table} t WHERE strpos(t::text,$1)>0`, [id]);
        if (count) found[table] = count;
      }
      return found;
    };

    assert.deepEqual(await adopt([L1]), { machineId: D, adopted: [L1], reused: [] });
    assert.deepEqual(await spelling(L1), {});
    assert.deepEqual(await adopt([L1, L2]), { machineId: D, adopted: [L2], reused: [L1] });
    assert.deepEqual(await spelling(L2), {});

    // One registration, one Space registration, one workspace and one Machine
    // name; the first adopted profile's rows won the merge.
    assert.deepEqual(await run(`SELECT machine_id,harness FROM data.agent_registrations WHERE owner_user_id='alice'`),
      [{ machine_id: D, harness: "codex" }]);
    assert.deepEqual(await run(`SELECT display_name,configuration_json->'workspaceReferences' AS refs
      FROM data.space_agent_registrations WHERE owner_user_id='alice'`), [{ display_name: "First", refs: [workspace(D)] }]);
    assert.deepEqual(await run(`SELECT grant_limits->'workspaces' AS workspaces FROM data.space_agent_registration_access
      WHERE owner_user_id='alice'`), [{ workspaces: [workspace(D)] }]);
    assert.deepEqual(await run(`SELECT workspace_id,metadata_json->>'displayName' AS label FROM data.workspaces
      WHERE owner_user_id='alice'`), [{ workspace_id: workspace(D), label: "First" }]);
    assert.deepEqual(await run(`SELECT machine_id,name FROM data.machines WHERE owner_user_id='alice'`),
      [{ machine_id: D, name: "First host" }]);
    // Both Runs survive and now name the adopted Machine and workspace.
    assert.deepEqual(await run(`SELECT run_id,workspace_id,workspace_machine_id,metadata_json->>'machineId' AS machine
      FROM data.runs WHERE owner_user_id='alice' ORDER BY run_id`), [
      { run_id: "channel:1#1", workspace_id: workspace(D), workspace_machine_id: D, machine: D },
      { run_id: "channel:2#1", workspace_id: workspace(D), workspace_machine_id: D, machine: D }]);
    assert.deepEqual(await run(`SELECT run_id,machine_id FROM data.run_agent_registrations WHERE owner_user_id='alice'
      ORDER BY run_id`), [{ run_id: "channel:1#1", machine_id: D }, { run_id: "channel:2#1", machine_id: D }]);
    // One daemon per host: the first moved under its new daemon id, the second was a stale duplicate.
    assert.deepEqual(await run(`SELECT daemon_id,machine_id FROM data.machine_daemons WHERE owner_user_id='alice'`),
      [{ daemon_id: daemonId("alice", D, "studio"), machine_id: D }]);
    assert.deepEqual((await run(`SELECT legacy_machine_id,machine_id FROM control.machine_identity_adoptions
      ORDER BY legacy_machine_id`)).map(row => [row.legacy_machine_id, row.machine_id]), [[L1, D], [L2, D]]);

    // Another owner's rows are untouched.
    assert.equal((await spelling(OTHER))["data.agent_registrations"], 1);
    assert.equal((await spelling(OTHER))["data.runs"], 1);

    await assert.rejects(adopt([L1], `machine:${"b".repeat(64)}`), error =>
      error instanceof MachineIdentityAdoptionError && error.code === "machine_identity_adoption_conflict");
    await assert.rejects(adopt([L1], "machine:not-derived"), error => error.code === "invalid_machine_identity");
    await assert.rejects(adopt([D]), error => error.code === "invalid_machine_identity");
    // An id the owner never used is not adopted, even when another owner uses it.
    assert.deepEqual(await adopt([OTHER]), { machineId: D, adopted: [], reused: [] });
    assert.equal((await spelling(OTHER))["data.runs"], 1);
  } finally { await fixture.close(); }
});
