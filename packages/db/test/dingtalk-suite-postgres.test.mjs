import assert from "node:assert/strict";
import { connectorDatabase, integration } from "./postgres-database.fixture.mjs";
import { PostgresDingTalkSuiteRepository, dingtalkAppIdentity } from "../dist/index.js";
async function fixture(run) {
  const {client,database,sql}=await connectorDatabase("dingtalk-suite-test");
  const app={suiteKey:"suite"+crypto.randomUUID().replaceAll("-",""),eventKeyDigest:"a".repeat(64)}, identity=dingtalkAppIdentity(app);
  const repository=new PostgresDingTalkSuiteRepository(database,"fixture-encryption-material");
  const request=extra=>({requestId:crypto.randomUUID(),app,...extra});
  const event=async extra=>request({eventId:crypto.randomUUID(),eventTime:(await sql("SELECT clock_timestamp() AS at")).rows[0].at.toISOString(),...extra});
  try { await run({app,identity,repository,request,event,sql,database}); }
  finally { await sql("DELETE FROM data.app_dingtalk_suite_tickets WHERE app_identity=$1",[identity]);await database.close?.();await client.end(); }
}
integration("DingTalk ticket remains encrypted and current until replaced, rather than expiring like a WeCom ticket",async()=>fixture(async({repository,event,request,sql,identity})=>{
  await repository.acceptTicket(await event({ticket:"private_ticket_after_five_hours"}));
  const row=(await sql("SELECT * FROM data.app_dingtalk_suite_tickets WHERE app_identity=$1",[identity])).rows[0];
  assert.doesNotMatch(JSON.stringify(row),/private_ticket_after_five_hours/);
  await sql("UPDATE data.app_dingtalk_suite_tickets SET event_time=clock_timestamp()-interval '6 hours' WHERE app_identity=$1",[identity]);
  assert.equal(await repository.ticket(request()),"private_ticket_after_five_hours");
  await repository.acceptTicket(await event({ticket:"replacement_ticket"}));assert.equal(await repository.ticket(request()),"replacement_ticket");
  assert.equal((await sql("SELECT count(*)::int AS count FROM data.app_connector_connections WHERE provider_id='dingtalk' AND created_by='dingtalk-suite-test'")).rows[0].count,0);
}));
integration("DingTalk concurrent order, ambiguous same-time pushes and duplicate callbacks cannot revive a retired ticket",async()=>fixture(async({repository,event,request,sql,identity})=>{
  const first=await event({ticket:"first"});await repository.acceptTicket(first);
  await Promise.all([repository.acceptTicket({...first,eventId:"later",eventTime:new Date(Date.parse(first.eventTime)+1).toISOString(),ticket:"latest"}),
    repository.acceptTicket({...first,eventId:"stale",eventTime:new Date(Date.parse(first.eventTime)-1).toISOString(),ticket:"stale"})]);
  assert.equal(await repository.ticket(request()),"latest");
  const conflict={...first,eventTime:new Date(Date.parse(first.eventTime)+1).toISOString(),eventId:"conflict",ticket:"conflicting"};
  await assert.rejects(repository.acceptTicket(conflict),e=>e.code==="dingtalk_ticket_ambiguous");
  const row=(await sql("SELECT * FROM data.app_dingtalk_suite_tickets WHERE app_identity=$1",[identity])).rows[0];
  assert.equal(row.ambiguous,true);assert.deepEqual(row.encrypted_value_json,{});
  await repository.acceptTicket(first);await assert.rejects(repository.ticket(request()),e=>e.code==="dingtalk_ticket_missing");
  await repository.acceptTicket({...first,eventId:"fresh",eventTime:new Date(Date.parse(first.eventTime)+2).toISOString(),ticket:"fresh"});
  assert.equal(await repository.ticket(request()),"fresh");
}));
integration("DingTalk key rotation, tampering, future events and expired pushes fail closed",async()=>fixture(async({repository,event,request,sql,identity,database,app})=>{
  await assert.rejects(repository.ticket(request()),e=>e.code==="dingtalk_ticket_missing");
  for(const delta of [-601000,31000])await assert.rejects(repository.acceptTicket(await event({ticket:"bad",eventTime:new Date(Date.now()+delta).toISOString()})),e=>e.status===409);
  await repository.acceptTicket(await event({ticket:"private"}));
  await assert.rejects(repository.ticket(request({app:{...app,eventKeyDigest:"b".repeat(64)}})),e=>e.code==="dingtalk_ticket_missing");
  await assert.rejects(new PostgresDingTalkSuiteRepository(database,"wrong").ticket(request()),e=>e.code==="secret_authority_corrupt");
  await sql("UPDATE data.app_dingtalk_suite_tickets SET version=version+1 WHERE app_identity=$1",[identity]);
  await assert.rejects(repository.ticket(request()),e=>e.code==="secret_authority_corrupt");
  assert.throws(()=>new PostgresDingTalkSuiteRepository({...database,cacheMode:"enabled"},"key"),e=>e.status===503);
}));
