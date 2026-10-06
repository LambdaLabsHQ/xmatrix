import assert from 'node:assert/strict';
import { connectorDatabase, integration } from './postgres-database.fixture.mjs';
import { PostgresDingTalkSuiteRepository, PostgresDingTalkTokenRepository, dingtalkAppIdentity } from '../dist/index.js';
async function fixture(run) {
  const { database, client, sql } = await connectorDatabase('dingtalk-token-boundary');
  const app = { suiteKey: 'suite' + crypto.randomUUID().replaceAll('-', ''), eventKeyDigest: 'a'.repeat(64) };
  const identity = dingtalkAppIdentity(app), material = 'private-fixture-key';
  const tickets = new PostgresDingTalkSuiteRepository(database, material), tokens = new PostgresDingTalkTokenRepository(database, material);
  const request = extra => ({ requestId: crypto.randomUUID(), app, ...extra });
  let at = Date.now();
  const ticket = async () => { await tickets.acceptTicket(request({eventId:crypto.randomUUID(),eventTime:new Date(++at).toISOString(),ticket:'private_ticket_'+at})); return tickets.snapshot(request()); };
  try { const snapshot=await ticket();await run({tokens,tickets,ticket,request,sql,identity,database,material,snapshot}); }
  finally { await sql('DELETE FROM data.app_dingtalk_company_tokens WHERE app_identity=$1',[identity]);await sql('DELETE FROM data.app_dingtalk_suite_tickets WHERE app_identity=$1',[identity]);await database.close?.();await client.end(); }
}
integration('DingTalk provider TTL cache is encrypted and isolated by company and token audience',async()=>fixture(async({tokens,request,sql,identity,snapshot})=>{
  const key={kind:'corp',corpId:'dingCaseCompany',ticketVersion:snapshot.version}, lease=await tokens.acquire(request(key));
  assert.ok(lease.leaseId);await tokens.save(request({...key,...lease,value:'private_corp_token',expireIn:7200}));
  assert.deepEqual(await tokens.acquire(request(key)),{value:'private_corp_token'});
  const row=(await sql('SELECT * FROM data.app_dingtalk_company_tokens WHERE app_identity=$1',[identity])).rows[0];
  assert.doesNotMatch(JSON.stringify(row),/private_corp_token/);
  const ttl=Number(row.expires_epoch)-Math.floor(Date.now()/1000);assert.ok(ttl>=7165&&ttl<=7170);
  for(const other of [{...key,corpId:'dingOtherCompany'},{kind:'suite',ticketVersion:snapshot.version}])assert.ok((await tokens.acquire(request(other))).leaseId);
  await assert.rejects(tokens.acquire(request({...key,kind:'suite'})),e=>e.status===409);
}));
integration('DingTalk simultaneous refresh admits one lease and never reuses an expired lease',async()=>fixture(async({tokens,request,sql,identity,snapshot})=>{
  const key={kind:'suite',ticketVersion:snapshot.version};
  const results=await Promise.allSettled([tokens.acquire(request(key)),tokens.acquire(request(key))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'dingtalk_token_refresh_busy');
  const old=results.find(r=>r.status==='fulfilled').value;
  await sql("UPDATE data.app_dingtalk_company_tokens SET lease_until=clock_timestamp()-interval '1 second' WHERE app_identity=$1",[identity]);
  const fresh=await tokens.acquire(request(key));assert.notEqual(fresh.generation,old.generation);
  await assert.rejects(tokens.save(request({...key,...old,value:'private_stale_token',expireIn:60})),e=>e.status===409);
  await tokens.save(request({...key,...fresh,value:'private_current_token',expireIn:60}));
  assert.deepEqual(await tokens.acquire(request(key)),{value:'private_current_token'});
}));
integration('DingTalk primary ticket version retires both cached tokens and in-flight writes',async()=>fixture(async({tokens,request,ticket,snapshot})=>{
  const key={kind:'corp',corpId:'dingPrivateCompany',ticketVersion:snapshot.version},old=await tokens.acquire(request(key));
  const next=await ticket();assert.ok(next.version>snapshot.version);
  await assert.rejects(tokens.save(request({...key,...old,value:'private_late_token',expireIn:7200})),e=>e.status===409);
  await assert.rejects(tokens.acquire(request(key)),e=>e.status===409);
  assert.ok((await tokens.acquire(request({...key,ticketVersion:next.version}))).leaseId);
}));
integration('DingTalk token expiry, encrypted audience tampering and material rotation fail closed',async()=>fixture(async({tokens,request,sql,identity,database,snapshot})=>{
  const key={kind:'corp',corpId:'dingPrivateCompany',ticketVersion:snapshot.version},lease=await tokens.acquire(request(key));
  await tokens.save(request({...key,...lease,value:'private_valid_token',expireIn:60}));
  await assert.rejects(new PostgresDingTalkTokenRepository(database,'rotated').acquire(request(key)),e=>e.code==='secret_authority_corrupt');
  await sql('UPDATE data.app_dingtalk_company_tokens SET token_generation=$2 WHERE app_identity=$1',[identity,crypto.randomUUID()]);
  await assert.rejects(tokens.acquire(request(key)),e=>e.code==='secret_authority_corrupt');
  await sql('UPDATE data.app_dingtalk_company_tokens SET expires_epoch=0 WHERE app_identity=$1',[identity]);
  assert.ok((await tokens.acquire(request(key))).leaseId);
  assert.throws(()=>new PostgresDingTalkTokenRepository({...database,cacheMode:'enabled'},'key'),e=>e.status===503);
}));
integration('DingTalk invalid provider expiry is rejected without committing plaintext or releasing the lease',async()=>fixture(async({tokens,request,sql,identity,snapshot})=>{
  const key={kind:'suite',ticketVersion:snapshot.version},lease=await tokens.acquire(request(key));
  for(const expireIn of [0,30,7201,1.5])await assert.rejects(tokens.save(request({...key,...lease,value:'private_token',expireIn})),e=>e.status===409);
  const row=(await sql('SELECT * FROM data.app_dingtalk_company_tokens WHERE app_identity=$1',[identity])).rows[0];
  assert.deepEqual(row.encrypted_value_json,{});assert.equal(row.lease_id,lease.leaseId);
}));
