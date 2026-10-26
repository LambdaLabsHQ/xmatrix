import assert from "node:assert/strict";
import { isolatedPostgres, integration } from "./postgres-database.fixture.mjs";
import { applyMigration, loadMigrationManifest } from "../scripts/migrate.mjs";

// Dropping or retyping a column silently drops every index that contains it.
// 0137 removed host_id that way and took the Machine Run route and Launch
// delivery indexes with it; production then scanned both tables on every
// daemon report and reconnect until 0220. An index may leave only through a
// migration that names it. These went with their columns, and no remaining
// query or uniqueness rule depends on them.
const ACCEPTED_IMPLICIT_LOSSES = new Map([
  // Registration-only Agents retired target profiles and routing invocations.
  ["agent_launches_channel_id_trigger_id_target_profile_id_laun_key", "0105_contract_registration_only"],
  ["agent_routing_latency_idx", "0105_contract_registration_only"],
  // Pages replaced threads, direct participants and archived Channels. Channel
  // names need not be unique: name_key carries the Channel id.
  ["channels_active_direct_participant_key_idx", "0112_contract_pages_cutover"],
  ["channels_active_sibling_name_idx", "0112_contract_pages_cutover"],
  ["channels_active_thread_root_idx", "0112_contract_pages_cutover"],
  ["channels_space_parent_activity_idx", "0112_contract_pages_cutover"],
  ["channels_space_parent_idx", "0112_contract_pages_cutover"],
  ["channels_thread_history_lookup_idx", "0112_contract_pages_cutover"],
  // The daemon id now derives from owner, Machine and host; its primary key is that rule.
  ["machine_daemons_owner_user_id_machine_id_host_id_key", "0137_contract_retire_legacy_hostname"],
  // Nothing looks a request up by daemonRequestId any more.
  ["machine_request_delivery_status_idx", "0137_contract_retire_legacy_hostname"],
  // The head's primary key (owner, Machine, Channel) is its identity.
  ["machine_run_snapshot_heads_legacy_observation_key", "0137_contract_retire_legacy_hostname"],
]);

integration("an index leaves the schema only through a migration that names it", async () => {
  const isolated = await isolatedPostgres("index_drift", { migrate: false });
  const { client, role } = isolated;
  try {
    const indexes = async () => new Map((await client.query(`SELECT indexname,schemaname||'.'||tablename AS relation
      FROM pg_indexes WHERE schemaname IN ('control','data')`)).rows.map(row => [row.indexname, row.relation]));
    const lost = new Map();
    let before = new Map();
    for (const migration of await loadMigrationManifest()) {
      await applyMigration(client, migration, "fixture", role);
      const after = await indexes();
      for (const [name, relation] of before) {
        if (after.has(name) || new RegExp(`\\b${name}\\b`, "iu").test(migration.source)) continue;
        const { rows } = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [relation]);
        if (rows[0].present) lost.set(name, migration.id);
      }
      before = after;
    }
    const unrestored = new Map([...lost].filter(([name]) => !before.has(name)));
    assert.deepEqual(unrestored, ACCEPTED_IMPLICIT_LOSSES,
      "a migration dropped an index without naming it; rebuild it or drop it explicitly");
  } finally {
    await isolated.close();
  }
});

integration("daemon reports and reconnects read a Machine's open work without scanning its history", async () => {
  const isolated = await isolatedPostgres("machine_open_work");
  const { client } = isolated;
  try {
    // Closed history dominates both tables: about 2,200 routes per busy
    // Machine in production, of which a handful are open.
    await client.query(`INSERT INTO data.machine_run_routes (run_id,owner_user_id,machine_id,channel_id,execution_key,created_at,updated_at,terminal_at)
      SELECT 'run-'||n,'owner-'||(n%20),'machine-'||(n%40),'channel-'||(n%300),'key-'||n,now(),now(),
        CASE WHEN n%500=0 THEN NULL ELSE now() END FROM generate_series(1,40000) n;
      INSERT INTO data.agent_launches (launch_id,space_id,channel_id,trigger_id,launch_kind,owner_user_id,run_id,
        instance_id,execution_key,control_id,machine_id,state,spawn_payload_json,attempt,next_attempt_at,retryable,
        daemon_offline,version,created_at,updated_at)
      SELECT 'launch-'||n,'space','channel-'||(n%300),'trigger-'||n,'message','owner-'||(n%20),'run-'||n,'instance-'||n,
        'key-'||n,'control-'||n,'machine-'||(n%40),CASE WHEN n%500=0 THEN 'queued' ELSE 'connected' END,'{}',0,now(),
        false,false,1,now(),now() FROM generate_series(1,40000) n;
      ANALYZE data.machine_run_routes; ANALYZE data.agent_launches`);
    const scans = async (query, values) => {
      const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${query}`, values)).rows[0]["QUERY PLAN"][0].Plan;
      const nodes = function* (node) { yield node; for (const child of node.Plans ?? []) yield* nodes(child); };
      return [...nodes(plan)].filter(node => node["Node Type"] === "Seq Scan").map(node => node["Relation Name"]);
    };
    const machine = ["owner-0", "machine-0"];
    for (const [query, values] of [
      [`SELECT DISTINCT channel_id FROM data.machine_run_routes WHERE owner_user_id=$1
        AND machine_id=$2 AND terminal_at IS NULL AND (run_id=ANY($3::text[]) OR updated_at>$4)
        ORDER BY channel_id LIMIT 1001`, [...machine, ["run-500"], new Date()]],
      [`UPDATE data.machine_run_routes SET updated_at=$1 WHERE owner_user_id=$2
        AND machine_id=$3 AND terminal_at IS NULL AND run_id=ANY($4::text[])`, [new Date(), ...machine, ["run-500"]]],
      [`SELECT run_id FROM data.machine_run_routes WHERE owner_user_id=$1 AND machine_id=$2
        AND terminal_at IS NULL ORDER BY run_id LIMIT 101`, machine],
      [`SELECT DISTINCT channel_id FROM data.agent_launches
        WHERE owner_user_id=$1 AND machine_id=$2 AND state IN ('prepared','queued') LIMIT 100`, machine],
    ]) assert.deepEqual(await scans(query, values), [], query);
  } finally {
    await isolated.close();
  }
});
