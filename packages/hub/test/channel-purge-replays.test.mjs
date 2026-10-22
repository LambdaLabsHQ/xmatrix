import assert from "node:assert/strict";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";
import { createAuthorityDatabase, purgeChannelRows } from "@xmatrix/db";

async function retiredChannel(f) {
  await f.run(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,
    version,created_at,updated_at) VALUES('erased','space','erased','erased','deleted','rank',1,now(),now())`);
  await f.run(`INSERT INTO data.channel_deletions(space_id,channel_id,requested_by,requested_at,
    updated_at,state,objects_done) VALUES('space','erased','owner',now(),now(),'purging',true)`);
}

// The existing deletion test has tiny replay tables. It cannot catch the full
// scans that repeatedly roll back production erasure before its first commit.
integration("Channel erasure finds every replay shape without scanning unrelated receipts", async () => {
  const f = await isolatedPostgres("purge_replays", { shard: true });
  const tables = [
    ["control.scoped_control_command_replays", "result_json"],
    ["data.idempotency_keys", "result_json"],
    ["data.outbox", "payload_json"],
  ];
  try {
    await retiredChannel(f);
    // Four JSON locations, a native scope/aggregate identity, and a duplicate
    // match in several locations. Prefixes and text mentions must remain.
    const payloads = [
      { channelId: "erased" }, { message: { channelId: "erased" } },
      { channel: { id: "erased" } }, { task: { channelId: "erased" } }, {},
      { channelId: "kept", task: { channelId: "erased" } },
      { channelId: "erased-other" }, { body: "erased" },
    ];
    for (let n = 0; n < payloads.length; n++) {
      const json = JSON.stringify(payloads[n]);
      await f.run(`INSERT INTO control.scoped_control_command_replays
        (scope_kind,scope_id,command_id,command_kind,request_digest,result_json,created_at,expires_at)
        VALUES($1,$2,$3,'test',repeat('a',64),$4,now(),now()+interval '1 day')`,
      [n === 4 ? "channel" : "space", n === 4 ? "erased" : "space", `replay-${n}`, json]);
      await f.run(`INSERT INTO data.idempotency_keys(space_id,idempotency_key,command_kind,request_digest,
        result_json,created_at,expires_at) VALUES('space',$1,'test',repeat('a',64),$2,now(),now()+interval '1 day')`,
      [`receipt-${n}`, json]);
      await f.run(`INSERT INTO data.outbox(outbox_id,space_id,topic,aggregate_kind,aggregate_id,
        aggregate_sequence,payload_json,status,available_at,created_at,updated_at)
        VALUES($1,'space','test',$2,$3,$4,$5,'pending',now(),now(),now())`,
      [`outbox-${n}`, n === 4 ? "channel" : "space", n === 4 ? "erased" : "space", n + 1, json]);
    }
    await f.run(`INSERT INTO control.scoped_control_command_replays
      (scope_kind,scope_id,command_id,command_kind,request_digest,result_json,created_at,expires_at)
      SELECT 'channel','kept','bulk-'||n,'test',repeat('a',64),jsonb_build_object('channelId','kept-'||n),
        now(),now()+interval '1 day' FROM generate_series(1,10000) n`);
    await f.run(`INSERT INTO data.idempotency_keys(space_id,idempotency_key,command_kind,request_digest,
      result_json,created_at,expires_at) SELECT 'space','bulk-'||n,'test',repeat('a',64),
      jsonb_build_object('channelId','kept-'||n),now(),now()+interval '1 day' FROM generate_series(1,10000) n`);
    await f.run(`INSERT INTO data.outbox(outbox_id,space_id,topic,aggregate_kind,aggregate_id,
      aggregate_sequence,payload_json,status,available_at,created_at,updated_at)
      SELECT 'bulk-'||n,'space','test','channel','kept-'||n,1,jsonb_build_object('channelId','kept-'||n),
        'pending',now(),now(),now() FROM generate_series(1,10000) n`);
    for (const [table] of tables) await f.run(`ANALYZE ${table}`);
    const checked = new Set();
    let complete = false;
    for (let attempt = 0; attempt < 32 && !complete; attempt++) {
      complete = await f.session.transaction({ requestId: "purge-regression", operation: "channel-purge.advance" }, tx =>
        purgeChannelRows({ async query(input) {
        const table = tables.find(([name]) => input.text.startsWith(`DELETE FROM ${name} `))?.[0];
        if (table) {
          const [{ "QUERY PLAN": plan }] = await f.run(`EXPLAIN (FORMAT JSON) ${input.text}`, input.values);
          const nodes = node => [node, ...(node.Plans ?? []).flatMap(nodes)];
          assert.equal(nodes(plan[0].Plan).some(node => node["Node Type"] === "Seq Scan" &&
            node["Relation Name"] === table.split(".")[1]), false, `${table} must find a sparse Channel without a full scan`);
          checked.add(table);
        }
        return tx.query(input);
        } }, { spaceId: "space", channelId: "erased", at: new Date().toISOString() }));
    }
    assert.equal(complete, true);
    assert.equal(checked.size, 3);
    for (const [table, column] of tables) {
      assert.equal((await f.run(`SELECT count(*)::int AS n FROM ${table}`))[0].n,
        table === "data.idempotency_keys" ? 10003 : 10002);
      assert.equal((await f.run(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}->>'channelId'='erased-other'`))[0].n, 1);
      assert.equal((await f.run(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}->>'body'='erased'`))[0].n, 1);
    }
  } finally { await f.close(); }
});

integration("Channel erasure commits progress before cumulative round trips exhaust its transaction", async () => {
  const f = await isolatedPostgres("purge_roundtrips", { shard: true });
  try {
    await retiredChannel(f);
    const database = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0",
      statementTimeoutMs: 1000, transactionTimeoutMs: 2000, lockTimeoutMs: 500 });
    const context = { requestId: "bounded-erasure", operation: "channel-purge.advance" };
    const input = { spaceId: "space", channelId: "erased", at: new Date().toISOString() };
    // Real SQL stays fast; transport delays accumulate under PG's transaction
    // clock. The former entire-plan transaction dies before saving anything.
    assert.equal(await database.transaction(context, tx => purgeChannelRows({ async query(query) {
      await f.run("SELECT pg_sleep(0.05)");
      return tx.query(query);
    } }, input)), false);
    const [saved] = await f.run("SELECT step,row_plan_digest FROM data.channel_deletions");
    assert.ok(saved.step > 0);
    assert.match(saved.row_plan_digest, /^[a-f0-9]{64}$/u);
    // An older plan's cursor must revisit dependencies inserted before it.
    await f.run("UPDATE data.channel_deletions SET step=999,row_plan_digest=repeat('0',64)");
    await f.run(`INSERT INTO data.automations(automation_id,owner_user_id,channel_id,next_run_at,enabled,
      version,payload_json,created_at,updated_at,page_id)
      VALUES('older-plan-dependency','owner','erased',now(),true,1,'{}',now(),now(),'page')`);
    const advance = () => database.transaction(context, tx => purgeChannelRows(tx, input));
    assert.equal(await advance(), false);
    assert.equal((await f.run("SELECT count(*)::int AS n FROM data.automations"))[0].n, 0);
    let complete = false;
    for (let attempt = 0; attempt < 32 && !complete; attempt++) complete = await advance();
    assert.equal(complete, true);
    assert.equal((await f.run("SELECT count(*)::int AS n FROM data.channels"))[0].n, 0);
    assert.equal((await f.run("SELECT state FROM data.channel_deletions"))[0].state, "completed");
  } finally { await f.close(); }
});
