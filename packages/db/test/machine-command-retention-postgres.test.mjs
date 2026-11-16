import assert from "node:assert/strict";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import { parseLifecycleOptions, runLifecycleMaintenance } from "../scripts/postgres-lifecycle-maintenance.mjs";

const insert = (client, rows) => client.query(`INSERT INTO data.machine_daemon_commands
    (command_id,owner_user_id,machine_id,command_type,payload_json,status,attempts,version,
     created_at,updated_at,expires_at)
  SELECT id,'owner','machine',kind,'{}','completed',1,1,
    now()-created*interval '1 hour',now()-created*interval '1 hour',now()-expired*interval '1 hour'
  FROM jsonb_to_recordset($1::jsonb) AS row(id text,kind text,created numeric,expired numeric)`,
[JSON.stringify(rows)]);

// Some readers look back over commands by creation time (the harness action
// list and release repeat, the quota probe), a day at most, while their expiry
// can be ten minutes: removing a command at expiry would resend those notices.
integration("lifecycle removes Machine daemon commands only a week past expiry and creation", async () => {
  const f = await isolatedPostgres("command_retention");
  try {
    await insert(f.client, [
      { id: "old-spawn", kind: "spawn", created: 24 * 40, expired: 24 * 10 },
      { id: "old-probe", kind: "quota_probe", created: 24 * 8, expired: 24 * 8 },
      { id: "recent-release", kind: "harness_action", created: 2, expired: 1.8 },
      { id: "six-days-expired", kind: "text_task", created: 24 * 6, expired: 24 * 6 },
      { id: "live-stop", kind: "stop", created: 24 * 20, expired: -24 * 10 },
    ]);
    const dry = await runLifecycleMaintenance(f.client, parseLifecycleOptions(["--dry-run"]));
    assert.equal(dry.before.expiredMachineDaemonCommandRowsCapped, 2);
    assert.equal(dry.deletedExpiredMachineDaemonCommands, 0);
    const options = parseLifecycleOptions(["--batch-size=1", "--max-rows=10"]);
    assert.equal((await runLifecycleMaintenance(f.client, options)).deletedExpiredMachineDaemonCommands, 2);
    assert.equal((await runLifecycleMaintenance(f.client, options)).deletedExpiredMachineDaemonCommands, 0,
      "a repeated pass finds nothing left");
    assert.deepEqual((await f.run("SELECT command_id FROM data.machine_daemon_commands ORDER BY command_id"))
      .map(row => row.command_id), ["live-stop", "recent-release", "six-days-expired"]);
  } finally { await f.close(); }
});

integration("each Machine daemon command batch is a bounded read of the expiry index", async () => {
  const f = await isolatedPostgres("command_expiry_plan");
  try {
    await f.client.query(`INSERT INTO data.machine_daemon_commands
        (command_id,owner_user_id,machine_id,command_type,payload_json,status,attempts,version,
         created_at,updated_at,expires_at)
      SELECT 'live-'||n,'owner','machine','spawn','{}','completed',1,1,now(),now(),now()+interval '30 days'
      FROM generate_series(1,20000) n`);
    await f.client.query("ANALYZE data.machine_daemon_commands");
    const deletes = [];
    const recording = { query: (text, values) => {
      if (text.includes("DELETE FROM data.machine_daemon_commands")) deletes.push(text);
      return f.client.query(text, values);
    } };
    await runLifecycleMaintenance(recording, parseLifecycleOptions(["--max-rows=10"]));
    assert.equal(deletes.length, 1);
    const plan = (await f.client.query(`EXPLAIN (FORMAT JSON) ${deletes[0]}`, [1_000])).rows[0]["QUERY PLAN"][0].Plan;
    const nodes = function* (node) { yield node; for (const child of node.Plans ?? []) yield* nodes(child); };
    const reads = [...nodes(plan)].filter(node => node["Relation Name"] === "machine_daemon_commands"
      && node["Node Type"] !== "ModifyTable");
    assert.ok(reads.some(node => node["Index Name"] === "machine_daemon_commands_expiry_idx"
      && /expires_at/.test(node["Index Cond"] ?? "")), "the expiry must bound the batch's index range");
    assert.ok(!reads.some(node => node["Node Type"] === "Seq Scan"), "a batch must not scan the command table");
  } finally { await f.close(); }
});
