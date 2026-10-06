import assert from "node:assert/strict";
import { connectorDatabase, integration } from "./postgres-database.fixture.mjs";
import { PostgresWeComSuiteRepository, wecomAppIdentity } from "../dist/index.js";
async function fixture(run) {
  const {client,database,sql}=await connectorDatabase("wecom-suite-test");
  const app={suiteId:"ww"+crypto.randomUUID().replaceAll("-",""),eventKeyDigest:"a".repeat(64)}, identity=wecomAppIdentity(app);
  const repository=new PostgresWeComSuiteRepository(database,"fixture-encryption-material");
  const request=extra=>({requestId:crypto.randomUUID(),app,...extra});
  const event=async extra=>request({eventId:crypto.randomUUID(),eventTime:(await sql("SELECT clock_timestamp() AS at")).rows[0].at.toISOString(),...extra});
  try { await run({app,identity,repository,request,event,sql,database}); }
  finally { await sql("DELETE FROM data.app_wecom_suite_tickets WHERE app_identity=$1",[identity]);await database.close?.();await client.end(); }
}
integration("WeCom suite tickets are encrypted, monotonic under concurrent callbacks and not Space grants",async()=>fixture(async({repository,event,request,sql,identity})=>{
  const first=await event({ticket:"private-fixture-ticket"});await repository.acceptTicket(first);
  const row=(await sql("SELECT * FROM data.app_wecom_suite_tickets WHERE app_identity=$1",[identity])).rows[0];assert.doesNotMatch(JSON.stringify(row),/private-fixture-ticket/);
  await Promise.all([repository.acceptTicket({...first,eventId:"later",eventTime:new Date(Date.parse(first.eventTime)+1).toISOString(),ticket:"latest-ticket"}),repository.acceptTicket({...first,eventId:"stale",eventTime:new Date(Date.parse(first.eventTime)-1).toISOString(),ticket:"stale-ticket"})]);
  assert.equal(await repository.ticket(request()),"latest-ticket");
  await repository.acceptTicket({...first,eventTime:new Date(Date.parse(first.eventTime)+2).toISOString(),eventId:"later",ticket:"replay"});assert.equal(await repository.ticket(request()),"latest-ticket");
  assert.equal((await sql("SELECT count(*)::int AS count FROM data.app_connector_connections WHERE provider_id='wecom' AND created_by='wecom-suite-test'")).rows[0].count,0);
  await sql("UPDATE data.app_wecom_suite_tickets SET encrypted_value_json=$2::jsonb WHERE app_identity=$1",[identity,JSON.stringify(row.encrypted_value_json)]);
  await assert.rejects(repository.ticket(request()),e=>e.code==="secret_authority_corrupt");
}));
integration("WeCom ticket expiry, key rotation, wrong encryption material and future events fail closed",async()=>fixture(async({repository,event,request,sql,identity,database,app})=>{
  await assert.rejects(repository.ticket(request()),e=>e.code==="wecom_ticket_missing");
  for(const delta of [-601000,31000])await assert.rejects(repository.acceptTicket(await event({ticket:"expired",eventTime:new Date(Date.now()+delta).toISOString()})),e=>e.status===409);
  await repository.acceptTicket(await event({ticket:"active-ticket"}));
  await assert.rejects(repository.ticket(request({app:{...app,eventKeyDigest:"b".repeat(64)}})),e=>e.code==="wecom_ticket_missing");
  await assert.rejects(new PostgresWeComSuiteRepository(database,"wrong-material").ticket(request()),e=>e.code==="secret_authority_corrupt");
  await sql("UPDATE data.app_wecom_suite_tickets SET event_time=clock_timestamp()-interval '30 minutes' WHERE app_identity=$1",[identity]);
  await assert.rejects(repository.ticket(request()),e=>e.code==="wecom_ticket_missing");
  assert.throws(()=>new PostgresWeComSuiteRepository({...database,cacheMode:"enabled"},"material"),e=>e.status===503);
}));
integration("same-second conflicting WeCom tickets retire the private envelope until a newer push",async()=>fixture(async({repository,event,request,sql,identity})=>{
  const first=await event({ticket:"first-ticket"});await repository.acceptTicket(first);
  await assert.rejects(repository.acceptTicket({...first,eventId:"conflicting",ticket:"different-ticket"}),e=>e.code==="wecom_ticket_ambiguous");
  const row=(await sql("SELECT ambiguous,encrypted_value_json FROM data.app_wecom_suite_tickets WHERE app_identity=$1",[identity])).rows[0];assert.equal(row.ambiguous,true);assert.deepEqual(row.encrypted_value_json,{});
  await repository.acceptTicket(first);await assert.rejects(repository.ticket(request()),e=>e.code==="wecom_ticket_missing");
  await repository.acceptTicket({...first,eventId:"newer",eventTime:new Date(Date.parse(first.eventTime)+1).toISOString(),ticket:"newer-ticket"});assert.equal(await repository.ticket(request()),"newer-ticket");
}));
