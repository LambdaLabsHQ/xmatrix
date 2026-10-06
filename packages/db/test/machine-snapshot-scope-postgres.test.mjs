import { isolatedPostgres, assertMigrationTooLarge, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PostgresMachineLifecycleRepository } from "../dist/runtime-lifecycle-control.js";
import { activePlacementRow } from "./recording-database.fixture.mjs";

integration("snapshot migration preserves the highest causal head; hostname changes cannot bypass replay or epoch fences", async () => {
  const isolated = await isolatedPostgres("snapshot_scope", { migrate: false, runtimeRole: false });
  const { client, url } = isolated;
  try {
    const original = await readFile(new URL("../migrations/0038_expand_machine_run_snapshot_causality.sql",import.meta.url),"utf8");
    const migration = await readFile(new URL("../migrations/0135_contract_machine_snapshot_scope.sql",import.meta.url),"utf8");
    await client.query("CREATE SCHEMA data"); await client.query(original);
    await client.query(`INSERT INTO data.machine_run_snapshot_heads VALUES
      ('owner','machine','old','channel',3,999,now(),now()),
      ('owner','machine','current','channel',4,10,now(),now()),
      ('other','machine','current','channel',7,8,now(),now())`);
    for (let i=0;i<2;i++) { await client.query("BEGIN"); await client.query(migration); await client.query("COMMIT"); }
    assert.deepEqual((await client.query("SELECT owner_user_id,host_id,connection_epoch,registry_sequence FROM data.machine_run_snapshot_heads ORDER BY owner_user_id")).rows,
      [{owner_user_id:"other",host_id:"current",connection_epoch:"7",registry_sequence:"8"},
       {owner_user_id:"owner",host_id:"current",connection_epoch:"4",registry_sequence:"10"}]);
    await client.query("ALTER TABLE data.machine_run_snapshot_heads ADD COLUMN hostname text");
    // The previous Hub still upserts its unchanged observation during deployment.
    await client.query(`INSERT INTO data.machine_run_snapshot_heads VALUES ('owner','machine','current','channel',4,11,now(),now())
      ON CONFLICT (owner_user_id,machine_id,host_id,channel_id) DO UPDATE SET registry_sequence=EXCLUDED.registry_sequence`);
    let accepted = 0;
    const database = { cacheMode:"disabled",transaction:async (_context,callback) => {
      const connection = new Client({connectionString:url.toString()}); await connection.connect(); await connection.query("BEGIN");
      try {
        const value=await callback({query:async query => {
          if(query.name === "channel_space_directory_resolve_v2") return [{channel_id:"channel",space_id:"space",shard_id:"shard-0",placement_epoch:1,entity_version:1}];
          if(query.name === "space_placement_resolve_v1") return [activePlacementRow("space")];
          if(query.name === "machine_lifecycle_head_advance_v1") return [{commit_sequence:1}];
          if(query.name === "machine_lifecycle_channel_v2") return [{channel_id:"channel",space_id:"space"}];
          if(query.name === "machine_lifecycle_snapshot_head_v2" || query.name === "machine_lifecycle_channel_lock_v1") {
            const {rows}=await connection.query(query.text,query.values);
            assert.ok(rows.length<=query.maxRows,query.name);
            if(query.name === "machine_lifecycle_snapshot_head_v2") accepted+=rows.length;
            return rows;
          }
          return [];
        }});
        await connection.query("COMMIT");return value;
      } catch(error) {await connection.query("ROLLBACK");throw error;} finally {await connection.end();}
    }};
    const repository=new PostgresMachineLifecycleRepository(database);
    const input=(epoch,sequence,hostId)=>({commandId:randomUUID(),ownerUserId:"owner",machineId:"machine",hostId,
      principal:{kind:"machine",ownerUserId:"owner",machineId:"machine"},channelId:"channel",eventType:"machine_run_snapshot",connectionEpoch:epoch,
      payload:{type:"machine_run_snapshot",snapshotComplete:true,registryConnectionEpoch:epoch,registrySequence:sequence,capturedAt:new Date().toISOString(),runs:[]}});
    await repository.apply(input(4,11,"renamed")); assert.equal(accepted,0,"renaming does not turn a replay into new evidence");
    await repository.apply(input(3,9999,"older")); assert.equal(accepted,0,"an older epoch cannot outrank the current connection");
    await repository.apply(input(4,12,undefined)); assert.equal(accepted,1,"a hostname is not required to advance causal evidence");
    assert.equal((await client.query("SELECT hostname FROM data.machine_run_snapshot_heads WHERE owner_user_id='owner'")).rows[0].hostname,null);
    await assert.rejects(repository.apply({...input(4,13,"bad"),principal:{kind:"machine",ownerUserId:"other",machineId:"machine"}}),/exact authenticated Machine/);
    await Promise.all([repository.apply(input(4,13,"one")),repository.apply(input(4,14,"two"))]);
    assert.equal((await client.query("SELECT registry_sequence FROM data.machine_run_snapshot_heads WHERE owner_user_id='owner'")).rows[0].registry_sequence,"14");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM data.machine_run_snapshot_heads")).rows[0].n,2);
    await client.query("DROP TABLE data.machine_run_snapshot_heads"); await client.query(original);
    await client.query(`INSERT INTO data.machine_run_snapshot_heads SELECT 'owner','machine','h'||n,'channel',1,n,now(),now() FROM generate_series(1,100001) n`);
    await assertMigrationTooLarge(client, migration, "SELECT count(*)::int AS n FROM data.machine_run_snapshot_heads");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await isolated.close();
  }
});
