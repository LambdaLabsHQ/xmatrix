import assert from "node:assert/strict";
import { connectorDatabase,integration } from "./postgres-database.fixture.mjs";
import { PostgresGmailRoutingRepository } from "../dist/index.js";

async function fixture(run) {
  const {client,database,sql}=await connectorDatabase("gmail-routing-test");
  const spaceId=`gmail-test-${crypto.randomUUID()}`,connectionId=`${spaceId}:gmail`,channelId=crypto.randomUUID();
  const generation=crypto.randomUUID(),repository=new PostgresGmailRoutingRepository(database,"fixture-encryption-key");
  const selection={address:"private@example.com",account:"ca_fixture",owner:"user:owner",oauthVerifier:"private-verifier",appIdentity:"fixture-app"};
  try {
    await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES($1,'owner','owner',1,now(),now()),($1,'viewer','viewer',1,now(),now())`,[spaceId]);
    await sql(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES($1,$2,'Gmail test','gmail test','open',$1,1,'{}',now(),now())`,[channelId,spaceId]);
    await sql(`INSERT INTO data.app_connector_connections(space_id,connection_id,version,provider_id,provider_name,status,
      auth_mode,scopes_json,secret_refs_json,capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
      VALUES($1,$2,1,'gmail','Gmail','configured','oauth','[]','[]','[]','[]','owner',$3,now(),now())`,[spaceId,connectionId,generation]);
    await sql(`INSERT INTO data.app_connector_credentials(connection_id,space_id,field_names_json,encrypted_value_json,
      version,updated_by,created_at,updated_at) VALUES($1,$2,'[]','{}',1,'owner',now(),now())`,[connectionId,spaceId]);
    const create=(changes={})=>repository.create({spaceId,userId:"owner",channelId,credentialVersion:1,generation,
      mailboxDigest:"mailbox-digest",tokenDigest:"signal-digest",nonceDigest:"nonce-digest",selection,historyId:"0",...changes});
    const activate=async()=>{const id=await create();const job=await repository.consumeOAuth(id,"owner","nonce-digest");
      await repository.activate(job,"private-refresh-token","100",new Date(Date.now()+86400000).toISOString());return id;};
    await run({repository,sql,create,activate,spaceId,channelId,connectionId});
  }finally {
    for(const table of ["app_gmail_routes","app_connector_credentials","app_connector_connections","channels","space_members"])
      await sql(`DELETE FROM data.${table} WHERE space_id=$1`,[spaceId]);
    await database.close?.();await client.end();
  }
}
integration("notification authorization is single-use, owner-bound and encrypted; failed replacement leaves the old watcher",async()=>{
  await fixture(async({repository,create,activate,sql,spaceId})=>{
    await assert.rejects(create({userId:"viewer"}));
    await assert.rejects(create({selection:{address:"other@example.com",account:"ca_other",owner:"user:other",oauthVerifier:"v",appIdentity:"a"}}));
    const active=await activate(),pending=await create();
    const outcomes=await Promise.allSettled([repository.consumeOAuth(pending,"owner","nonce-digest"),repository.consumeOAuth(pending,"owner","nonce-digest")]);
    assert.equal(outcomes.filter(result=>result.status==="fulfilled").length,1);
    assert.equal((await repository.list(spaceId,"owner")).find(row=>row.id===active).enabled,true);
    const rows=(await sql("SELECT * FROM data.app_gmail_routes WHERE space_id=$1",[spaceId])).rows;
    assert.doesNotMatch(JSON.stringify(rows),/private@example|private-refresh-token|private-verifier/);
    await assert.rejects(repository.list(spaceId,"viewer"));
  });
});
integration("signals survive coalescing during leases; renewal and outbox replay never skip the consumed cursor",async()=>{
  await fixture(async({repository,activate,sql,spaceId,connectionId})=>{
    const id=await activate();await repository.signal("signal-digest");
    const [job]=await repository.claim();assert.equal(await repository.current(job),true);
    assert.equal((await repository.claim()).length,0);
    await repository.stage(job,["abcdef1234567890"],"100","page-two");
    await repository.stage(job,["abcdef1234567890"],"100","page-two");
    assert.deepEqual(await repository.pending(job),["abcdef1234567890"]);
    await repository.renewed(job,new Date(Date.now()+86400000).toISOString());
    assert.equal((await repository.list(spaceId,"owner")).find(row=>row.id===id).historyId,"100");
    await repository.signal("signal-digest");await repository.delivered(job,"abcdef1234567890");
    await repository.finish(job,"done");
    await sql("UPDATE data.app_gmail_routes SET available_at=now()-interval '1 second' WHERE route_id=$1",[id]);
    const [again]=await repository.claim();assert.equal(again.pendingWake,true);
    assert.equal(again.pageToken,"page-two");assert.deepEqual(await repository.pending(again),[]);
    await sql("UPDATE data.app_connector_credentials SET version=2 WHERE connection_id=$1",[connectionId]);
    assert.equal(await repository.current(again),false);
    await repository.stop(spaceId,"owner",id);assert.equal(await repository.current(again),false);
    assert.doesNotMatch(JSON.stringify((await sql("SELECT * FROM data.app_gmail_routes WHERE route_id=$1",[id])).rows),/private-refresh-token/);
  });
});

integration("abandoned OAuth attempts release capacity while live grants remain; blocked jobs erase their native grant",async()=>{
  await fixture(async({repository,activate,create,sql,spaceId})=>{
    const active=await activate(),pending=await create();
    await sql("UPDATE data.app_gmail_routes SET created_at=now()-interval '11 minutes' WHERE route_id=$1",[pending]);
    await repository.cleanup();
    assert.deepEqual((await repository.list(spaceId,"owner")).map(row=>row.id),[active]);
    await repository.signal("signal-digest");const [job]=await repository.claim();
    await repository.finish(job,"blocked");
    const stored=(await sql("SELECT encrypted_value_json,enabled FROM data.app_gmail_routes WHERE route_id=$1",[active])).rows[0];
    assert.deepEqual(stored.encrypted_value_json,{});assert.equal(stored.enabled,false);
    await repository.cleanup();
    assert.deepEqual(await repository.list(spaceId,"owner"),[]);
  });
});

integration("successful pagination never consumes the retry budget or marks queued events processed",async()=>{
  await fixture(async({repository,activate,sql})=>{
    const id=await activate();await repository.signal("signal-digest");
    for(let page=0;page<12;page++) {
      const [job]=await repository.claim();assert.ok(job);assert.equal(job.pendingWake,true);
      await repository.stage(job,[],"100",`page-${page}`);
      await repository.finish(job,"continue");
      await sql("UPDATE data.app_gmail_routes SET available_at=now()-interval '1 second' WHERE route_id=$1",[id]);
    }
    const stored=(await sql("SELECT attempts,error_code,history_id FROM data.app_gmail_routes WHERE route_id=$1",[id])).rows[0];
    assert.equal(stored.attempts,0);assert.equal(stored.error_code,null);assert.equal(stored.history_id,"100");
  });
});
