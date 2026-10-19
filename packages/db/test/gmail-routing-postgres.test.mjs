import assert from "node:assert/strict";
import { connectorDatabase,integration } from "./postgres-database.fixture.mjs";
import { erasePrivateAccountRows } from "../dist/account-deletion-cleanup.js";
import { PostgresGmailRoutingRepository, PostgresAppCredentialRepository } from "../dist/index.js";
import { encryptSecretValue } from "../dist/secret-value-control.js";

async function fixture(run) {
  const {client,database,sql}=await connectorDatabase("gmail-routing-test");
  const spaceId=`gmail-test-${crypto.randomUUID()}`,connectionId=`${spaceId}:gmail`;
  const generation=crypto.randomUUID(),repository=new PostgresGmailRoutingRepository(database,"fixture-encryption-key");
  const selection={address:"private@example.com",account:"ca_fixture",owner:"user:owner",oauthVerifier:"private-verifier",appIdentity:"fixture-app"};
  try {
    await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES($1,'owner','owner',1,now(),now()),($1,'viewer','viewer',1,now(),now())`,[spaceId]);
    await sql(`INSERT INTO data.app_connector_connections(space_id,connection_id,version,provider_id,provider_name,status,
      auth_mode,scopes_json,secret_refs_json,capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
      VALUES($1,$2,1,'gmail','Gmail','configured','oauth','[]','[]','[]','[]','owner',$3,now(),now())`,[spaceId,connectionId,generation]);
    const mailbox={address:selection.address,account:selection.account,owner:selection.owner};
    const envelope=await encryptSecretValue("fixture-encryption-key",`app-connection:${connectionId}`,"credentials",1,
      JSON.stringify({mailboxes:JSON.stringify([mailbox]),composioApiKey:"fixture-api-key"}));
    await sql(`INSERT INTO data.app_connector_credentials(connection_id,space_id,field_names_json,encrypted_value_json,
      version,updated_by,created_at,updated_at) VALUES($1,$2,'["mailboxes","composioApiKey"]',$3::jsonb,1,'owner',now(),now())`,
    [connectionId,spaceId,JSON.stringify(envelope)]);
    const create=(changes={})=>repository.create({spaceId,userId:"owner",credentialVersion:1,generation,
      mailboxDigest:"mailbox-digest",tokenDigest:"signal-digest",nonceDigest:"nonce-digest",selection,historyId:"0",...changes});
    const activate=async()=>{const id=await create();const job=await repository.consumeOAuth(id,"owner","nonce-digest");
      await repository.activate(job,"private-refresh-token","100",new Date(Date.now()+86400000).toISOString());return id;};
    const credentials=new PostgresAppCredentialRepository(database,"fixture-encryption-key");
    const put=fields=>credentials.put({requestId:crypto.randomUUID(),spaceId,providerId:"gmail",actorUserId:"owner",
      fields,policy:{allowed:["mailboxes","composioApiKey"]},at:new Date().toISOString()});
    await run({repository,database,sql,create,activate,put,mailbox,spaceId,connectionId});
  }finally {
    for(const table of ["app_gmail_routes","app_connector_credentials","app_connector_connections","space_members"])
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

integration("two pollers keep independent cursors and deduplication; adding a mailbox fences old workers without stopping existing mail",async()=>{
  await fixture(async({repository,create,put,mailbox,spaceId})=>{
    const token={accessToken:"cached-access",expiresAt:Date.now()+3600000};
    const enable=async(box,version,digest)=>{
      const id=await create({mode:"poll",credentialVersion:version,mailboxDigest:digest,
        selection:{...box,oauthVerifier:"proof",appIdentity:"fixture-app"}});
      const attempt=await repository.consumeOAuth(id,"owner","nonce-digest");
      await repository.activate(attempt,"private-refresh-token","100",undefined,{token,fingerprint:"10,7,8,6"});
      return id;
    };
    const first=await enable(mailbox,1,"mailbox-digest"),[stale]=await repository.claim();
    const message="abcdef1234567890";
    await repository.stage(stale,[message],"110","first-page");
    const other={address:"other@example.com",account:"ca_second",owner:"user:owner"};
    await put({mailboxes:JSON.stringify([mailbox,other])});
    const [preserved]=await repository.list(spaceId,"owner");
    assert.ok(preserved,"adding another mailbox must retain the existing listener");
    assert.equal(preserved.id,first);assert.equal(preserved.enabled,true);
    assert.equal(preserved.credentialVersion,2);assert.equal(preserved.historyId,"110");
    assert.equal(preserved.pageToken,"first-page");assert.equal(preserved.selection.refreshToken,"private-refresh-token");
    assert.equal(await repository.current(stale),false);
    await repository.finish(stale,"blocked");
    assert.equal((await repository.list(spaceId,"owner"))[0].enabled,true,"the stale worker cannot retire the retained grant");
    const second=await enable(other,2,"second-mailbox-digest");
    const jobs=await repository.claim(),a=jobs.find(job=>job.id===first),b=jobs.find(job=>job.id===second);
    assert.ok(a);assert.ok(b);assert.equal(await repository.current(a),true);assert.equal(await repository.current(b),true);
    await repository.stage(b,[message],"210");
    assert.deepEqual(await repository.pending(a),[message]);assert.deepEqual(await repository.pending(b),[message]);
    await repository.stop(spaceId,"owner",second);
    assert.equal(await repository.current(a),true);assert.equal(await repository.current(b),false);
    await repository.delivered(a,message);
    assert.deepEqual(await repository.pending(a),[]);
  });
});

integration("mailbox removal, reconnection and ownership changes retire only affected grants; shared credential changes retire all",async()=>{
  for(const change of ["remove","reconnect","owner","shared-key","malformed"])await fixture(async({repository,create,activate,put,mailbox,spaceId})=>{
    const first=await activate(),other={address:"other@example.com",account:"ca_second",owner:"user:owner"};
    await put({mailboxes:JSON.stringify([mailbox,other])});
    const second=await create({credentialVersion:2,mailboxDigest:"second-mailbox-digest",
      selection:{...other,oauthVerifier:"proof",appIdentity:"fixture-app"}});
    await repository.activate(await repository.consumeOAuth(second,"owner","nonce-digest"),"second-refresh","200",new Date(Date.now()+86400000).toISOString());
    const fields=change==="shared-key" ? {composioApiKey:"replacement-key"} : {mailboxes:change==="malformed" ? "{}" : JSON.stringify([
      mailbox,...(change==="remove" ? [] : [{...other,...(change==="reconnect" ? {account:"ca_reconnected"} : {owner:"user:viewer"})}]),
    ])};
    await put(fields);
    const alive=(await repository.list(spaceId,"owner")).filter(row=>row.enabled);
    assert.deepEqual(alive.map(row=>row.id),change==="shared-key" || change==="malformed" ? [] : [first],change);
    if(alive.length)assert.equal(alive[0].credentialVersion,3);
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
    assert.notDeepEqual(stored.encrypted_value_json,{});assert.equal(stored.enabled,false);
    assert.doesNotMatch(JSON.stringify((await repository.list(spaceId,"owner"))[0]),/private-refresh-token/);
    await repository.cleanup();
    const [blocked]=await repository.list(spaceId,"owner");
    assert.equal(blocked.id,active);assert.equal(blocked.error,"blocked");
    assert.equal(blocked.enabled,false);
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

integration("account closure immediately fences native work and account erasure removes its encrypted grant",async()=>{
  await fixture(async({repository,database,sql,create,spaceId})=>{
    const userId=`closing-${crypto.randomUUID()}`;
    await sql("INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at) VALUES($1,$2,'admin',1,now(),now())",[spaceId,userId]);
    try {
      const id=await create({userId,selection:{address:"private@example.com",account:"ca_fixture",owner:`user:${userId}`,oauthVerifier:"proof",appIdentity:"fixture-app"}});
      const attempt=await repository.consumeOAuth(id,userId,"nonce-digest");
      await repository.activate(attempt,"private-refresh-token","100",new Date(Date.now()+86400000).toISOString());
      await repository.signal("signal-digest");const [job]=await repository.claim();
      assert.equal(await repository.current(job),true);
      await sql("INSERT INTO data.account_deletion_fences(user_id,request_id,committed) VALUES($1,$2,true)",[userId,crypto.randomUUID()]);
      assert.equal(await repository.current(job),false);
      await assert.rejects(create({userId,selection:attempt.selection}));
      await database.transaction({requestId:crypto.randomUUID(),operation:"test.account-private-cleanup"},tx=>erasePrivateAccountRows(tx,userId));
      assert.equal((await sql("SELECT count(*)::int AS n FROM data.app_gmail_routes WHERE created_by=$1",[userId])).rows[0].n,0);
    }finally {await sql("DELETE FROM data.account_deletion_fences WHERE user_id=$1",[userId]);}
  });
});

integration("an expired worker cannot disable or finish a live watcher",async()=>{
  await fixture(async({repository,activate,sql,spaceId})=>{
    const id=await activate();await repository.signal("signal-digest");
    const [job]=await repository.claim();
    await sql("UPDATE data.app_gmail_routes SET lease_until=now()-interval '1 second' WHERE route_id=$1",[id]);
    assert.equal(await repository.current(job),false);
    await repository.finish(job,"blocked");
    await repository.finish(job,"done");
    const [visible]=await repository.list(spaceId,"owner");
    assert.equal(visible.enabled,true);assert.equal(visible.error,undefined);
    assert.equal(visible.selection.refreshToken,"private-refresh-token");
    const [next]=await repository.claim();assert.ok(next);assert.notEqual(next.leaseId,job.leaseId);
  });
});

integration("polling is leased without a push; failed confirmation survives unchanged counts and stop fences cached grants",async()=>{
  await fixture(async({repository,create,sql,spaceId})=>{
    const id=await create({mode:"poll"});
    const pending=await repository.consumeOAuth(id,"owner","nonce-digest");
    const token={accessToken:"private-cached-token",expiresAt:Date.now()+3600000};
    await repository.activate(pending,"private-refresh-token","100",undefined,{token,fingerprint:"10,7,8,6"});
    const [first]=await repository.claim();
    assert.equal(first.mode,"poll");assert.equal(first.pendingWake,false);
    assert.equal(first.selection.pollToken.accessToken,token.accessToken);
    await repository.polled(first,"11,8,9,7");
    assert.equal(first.pendingWake,true);
    await repository.finish(first,"retry");
    await sql("UPDATE data.app_gmail_routes SET available_at=now()-interval '1 second' WHERE route_id=$1",[id]);
    const [retry]=await repository.claim();
    await repository.polled(retry,"11,8,9,7");
    assert.equal(retry.pendingWake,true,"a failed search remains pending even when counts stop changing");
    await repository.stage(retry,["abcdef1234567890"],"200");
    await repository.stage(retry,["abcdef1234567890"],"200");
    assert.deepEqual(await repository.pending(retry),["abcdef1234567890"]);
    await repository.delivered(retry,"abcdef1234567890");
    await repository.searched(retry);await repository.finish(retry,"done");
    assert.equal((await repository.claim()).length,0,"minute scheduling prevents a tight idle loop");
    await repository.signal("signal-digest");
    const visible=(await repository.list(spaceId,"owner"))[0];
    assert.equal(visible.pendingWake,false,"native Pub/Sub cannot wake label pollers");
    assert.ok(Date.parse(visible.nextSearchAt)>Date.now()+14*60000);
    await sql("UPDATE data.app_gmail_routes SET next_poll_at=now()-interval '1 second',available_at=now()-interval '1 second',next_search_at=now()-interval '1 second',attempts=8 WHERE route_id=$1",[id]);
    const [fallback]=await repository.claim();
    assert.ok(fallback,"polling keeps retrying after the native retry budget is exhausted");
    assert.ok(Date.parse(fallback.nextSearchAt)<Date.now());
    await repository.stop(spaceId,"owner",id);
    await repository.cachePollToken(fallback,{...token,accessToken:"late-token"});
    await assert.rejects(repository.polled(fallback,"12,8,10,7"));
    assert.equal(await repository.current(fallback),false);
    assert.doesNotMatch(JSON.stringify((await sql("SELECT * FROM data.app_gmail_routes WHERE route_id=$1",[id])).rows),/private-cached-token|late-token|private-refresh-token/);
  });
});
