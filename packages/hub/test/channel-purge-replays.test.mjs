import assert from "node:assert/strict";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";
import { purgeChannelRows } from "@xmatrix/db";

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
    await f.run(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,
      version,created_at,updated_at) VALUES('erased','space','erased','erased','deleted','rank',1,now(),now())`);
    await f.run(`INSERT INTO data.channel_deletions(space_id,channel_id,requested_by,requested_at,
      updated_at,state,objects_done) VALUES('space','erased','owner',now(),now(),'purging',true)`);
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
    await f.session.transaction({ requestId: "purge-regression", operation: "channel-purge.advance" }, async tx => {
      assert.equal(await purgeChannelRows({ async query(input) {
        const table = tables.find(([name]) => input.text.startsWith(`DELETE FROM ${name} `))?.[0];
        if (table) {
          const [{ "QUERY PLAN": plan }] = await f.run(`EXPLAIN (FORMAT JSON) ${input.text}`, input.values);
          const nodes = node => [node, ...(node.Plans ?? []).flatMap(nodes)];
          assert.equal(nodes(plan[0].Plan).some(node => node["Node Type"] === "Seq Scan" &&
            node["Relation Name"] === table.split(".")[1]), false, `${table} must find a sparse Channel without a full scan`);
          checked.add(table);
        }
        return tx.query(input);
      } }, { spaceId: "space", channelId: "erased", at: new Date().toISOString() }), true);
    });
    assert.equal(checked.size, 3);
    for (const [table, column] of tables) {
      assert.equal((await f.run(`SELECT count(*)::int AS n FROM ${table}`))[0].n,
        table === "data.idempotency_keys" ? 10003 : 10002);
      assert.equal((await f.run(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}->>'channelId'='erased-other'`))[0].n, 1);
      assert.equal((await f.run(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}->>'body'='erased'`))[0].n, 1);
    }
  } finally { await f.close(); }
});
