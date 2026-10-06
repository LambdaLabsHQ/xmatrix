import assert from "node:assert/strict";
import { runLifecycleMaintenance, parseLifecycleOptions } from "../scripts/postgres-lifecycle-maintenance.mjs";
import { connectorDatabase, integration } from "./postgres-database.fixture.mjs";
import { PostgresWeComInstallRepository, PostgresWeComCompanyRepository, PostgresAppCredentialRepository,
  PostgresAppRepository, wecomAppIdentity, wecomRecipientRef } from "../dist/index.js";
const material="wecom-company-test-encryption", changed=e=>e.status===409;
async function fixture(run) {
  const {client,database,sql}=await connectorDatabase("wecom-company-test");
  const spaces=[0,1].map(()=>"wecom-test-"+crypto.randomUUID());
  const app={suiteId:"ww"+crypto.randomUUID().replaceAll("-",""),eventKeyDigest:"a".repeat(64)},identity=wecomAppIdentity(app);
  const grant={corpId:"wpOpaqueCompany",agentId:1000001,permanentCode:"private-permanent-fixture"};
  const installs=new PostgresWeComInstallRepository(database,material),companies=new PostgresWeComCompanyRepository(database,material);
  const credentials=new PostgresAppCredentialRepository(database,material),apps=new PostgresAppRepository(database);
  const request=extra=>({requestId:crypto.randomUUID(),app,actorUserId:"owner",...extra});
  const time=async()=> (await sql("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
  const begin=(index=0,extra={})=>installs.begin(request({spaceId:spaces[index],...extra}));
  const prepare=async(index=0,extra={})=>{const attempt=await begin(index);await installs.take(request(attempt));await installs.prepare(request({...attempt,grant,...extra}));return attempt;};
  const confirm=(attempt,index=0,extra={})=>installs.confirm(request({...attempt,spaceId:spaces[index],members:["MemberOne"],confirmed:true,...extra}));
  const resolve=(index=0,extra={})=>companies.resolve(request({spaceId:spaces[index],...extra}));
  try {
    for(const space of spaces){
      await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
        VALUES($1,'owner','owner',1,now(),now()),($1,'member','member',1,now(),now())`,[space]);
      await sql(`INSERT INTO data.app_connector_connections(space_id,connection_id,version,provider_id,provider_name,status,auth_mode,
        scopes_json,secret_refs_json,capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
        VALUES($1,$1||':wecom',1,'wecom','WeCom','disconnected','api-token','[]','[]','[]','[]','owner',$1||':generation',now(),now())`,[space]);
    }
    await run({client,sql,database,spaces,app,identity,grant,request,time,begin,prepare,confirm,resolve,installs,companies,credentials,apps});
  } finally {
    for(const table of ["app_wecom_company_lifecycle","app_wecom_suite_tokens"])await sql(`DELETE FROM data.${table} WHERE app_identity=$1`,[identity]);
    for(const table of ["app_source_relations","app_connector_connections","channels","space_deletions","space_members"])
      for(const space of spaces)await sql(`DELETE FROM data.${table} WHERE space_id=$1`,[space]);
    await database.close?.();await client.end();
  }
}
integration("WeCom one-use state is private, original-Human bound, concurrent safe and expires",async()=>fixture(async({begin,installs,request,sql,spaces})=>{
  await assert.rejects(begin(0,{actorUserId:"member"}),e=>e.status===404);
  const first=await begin();assert.match(first.state,/^[a-f0-9]{64}$/);
  const stored=(await sql("SELECT * FROM data.app_wecom_install_attempts WHERE space_id=$1",[spaces[0]])).rows[0];
  assert.doesNotMatch(JSON.stringify(stored),new RegExp(first.state));assert.equal(stored.expires_at-stored.started_at,600000);
  await assert.rejects(installs.take(request({...first,actorUserId:"member"})),changed);
  const results=await Promise.allSettled([installs.take(request(first)),installs.take(request(first))]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(results.filter(r=>r.status==="rejected").length,1);
  const next=await begin();await sql("UPDATE data.app_wecom_install_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE space_id=$1",[spaces[0]]);
  await assert.rejects(installs.take(request(next)),changed);await begin();
  assert.equal((await sql("SELECT count(*) FROM data.app_wecom_install_attempts WHERE space_id=$1",[spaces[0]])).rows[0].count,"1");
}));
integration("WeCom encrypted grants preserve manual credentials until successful exact member confirmation",async()=>fixture(async({credentials,spaces,prepare,confirm,resolve,sql,grant,installs,request})=>{
  await credentials.put({requestId:crypto.randomUUID(),spaceId:spaces[0],providerId:"wecom",actorUserId:"owner",fields:{webhookKey:"old-private-webhook"},policy:{allowed:["webhookKey"]},at:new Date().toISOString()});
  const pending=await prepare();assert.equal(await resolve(),null);
  assert.equal((await credentials.resolve({requestId:crypto.randomUUID(),spaceId:spaces[0],providerId:"wecom"})).values.webhookKey,"old-private-webhook");
  const row=(await sql("SELECT * FROM data.app_wecom_install_attempts WHERE space_id=$1",[spaces[0]])).rows[0];
  assert.doesNotMatch(JSON.stringify(row),/private-permanent-fixture|wpOpaqueCompany/);
  await assert.rejects(confirm(pending,1),changed);await assert.rejects(confirm(pending,0,{members:["@ALL"]}),changed);
  await confirm(pending);const live=await resolve();assert.equal(live.permanentCode,grant.permanentCode);assert.deepEqual(live.members,["memberone"]);
  assert.equal(await credentials.resolve({requestId:crypto.randomUUID(),spaceId:spaces[0],providerId:"wecom"}),null);
  const saved=(await sql("SELECT * FROM data.app_wecom_installations WHERE space_id=$1",[spaces[0]])).rows[0];
  assert.doesNotMatch(JSON.stringify(saved),/private-permanent-fixture|wpOpaqueCompany|memberone/);
  await assert.rejects(installs.prepared(request(pending)),changed);
}));
integration("pending WeCom install rejects removed admins, credential changes, app rotation and generation ABA",async()=>fixture(async({prepare,confirm,sql,spaces,credentials,app,resolve})=>{
  let pending=await prepare();await sql("UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id='owner'",[spaces[0]]);
  await assert.rejects(confirm(pending),e=>e.status===404);await sql("UPDATE data.space_members SET role='owner' WHERE space_id=$1 AND user_id='owner'",[spaces[0]]);
  await assert.rejects(confirm(pending,0,{app:{...app,eventKeyDigest:"b".repeat(64)}}),changed);
  await credentials.put({requestId:crypto.randomUUID(),spaceId:spaces[0],providerId:"wecom",actorUserId:"owner",fields:{webhookKey:"new-key"},policy:{allowed:["webhookKey"]},at:new Date().toISOString()});
  await assert.rejects(confirm(pending),changed);pending=await prepare();
  await sql("UPDATE data.app_connector_connections SET search_rank_sequence='new-generation' WHERE space_id=$1",[spaces[0]]);
  await assert.rejects(confirm(pending),changed);assert.equal(await resolve(),null);
}));
integration("native company retirement wins confirmation races, purges codes and cannot revive captured grants",async()=>fixture(async({prepare,confirm,resolve,companies,request,time,grant,sql,spaces})=>{
  const old=await prepare();await confirm(old);const captured=await resolve();const pending=await prepare(1);
  const eventTime=await time();await companies.retire(request({corpId:grant.corpId,eventTime}));
  assert.equal(await resolve(),null);assert.equal(await companies.current(request({installation:captured})),false);
  await assert.rejects(confirm(pending,1),changed);
  for(const table of ["app_wecom_installations","app_wecom_install_attempts"])
    assert.equal((await sql(`SELECT count(*) FROM data.${table} WHERE space_id=ANY($1::text[])`,[spaces])).rows[0].count,"0");
  assert.equal((await companies.retire(request({corpId:grant.corpId,eventTime}))).retired,0);
  await sql("UPDATE data.app_wecom_company_lifecycle SET changed_at=clock_timestamp()-interval '1 second' WHERE company_digest=$1",[captured.companyDigest]);
  const fresh=await prepare();await confirm(fresh);assert.notEqual((await resolve()).grantGeneration,captured.grantGeneration);
  const raced=await prepare(1),at=await time();await Promise.allSettled([confirm(raced,1),companies.retire(request({corpId:grant.corpId,eventTime:at}))]);
  assert.equal(await resolve(1),null);
}));
integration("WeCom primary routes require fresh post-confirmation company/member and exact current generation",async()=>fixture(async({prepare,confirm,resolve,companies,apps,request,time,grant,spaces,sql})=>{
  const before=await time();await confirm(await prepare());const live=await resolve(),ref=await wecomRecipientRef(live,"memberone");
  const input={corpId:grant.corpId,agentId:grant.agentId,memberId:"MemberOne",eventTime:await time()};
  assert.equal((await companies.routes(request(input))).length,1);assert.deepEqual(await companies.routes(request({...input,eventTime:before})),[]);
  for(const extra of [{corpId:"otherCorp"},{agentId:1},{memberId:"otherMember"},{app:{...request().app,eventKeyDigest:"b".repeat(64)}}])assert.deepEqual(await companies.routes(request({...input,...extra})),[]);
  const channel="channel-"+crypto.randomUUID();await sql(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
    VALUES($1,$2,'company',$1,'open',$1||':rank',1,now(),now())`,[channel,spaces[0]]);
  await sql(`INSERT INTO data.app_source_relations(relation_id,space_id,connection_id,channel_id,source_kind,source_ref,features_json,version,created_by,created_at,updated_at)
    VALUES($1,$2,$2||':wecom',$3,'repository',$4,'["messages"]',1,'owner',now(),now())`,[crypto.randomUUID(),spaces[0],channel,"wecom:"+ref]);
  const route={requestId:crypto.randomUUID(),connectionId:live.connectionId,sourceRef:"wecom:"+ref,limit:32,
    wecomBinding:{appIdentity:live.appIdentity,companyDigest:live.companyDigest,grantGeneration:live.grantGeneration}};
  assert.equal((await apps.connectorEventRoutes(route)).length,1);
  assert.equal((await apps.connectorEventRoutes({...route,wecomBinding:{...route.wecomBinding,companyDigest:"f".repeat(64)}})).length,0);
  await companies.retire(request({corpId:grant.corpId,eventTime:await time()}));assert.equal((await apps.connectorEventRoutes(route)).length,0);
}));
integration("WeCom ciphertext binds company, actor and connection; manual replacement and deletion purge native codes",async()=>fixture(async({prepare,confirm,resolve,sql,spaces,request,installs,companies,database,credentials})=>{
  const pending=await prepare();await sql("UPDATE data.app_wecom_install_attempts SET actor_user_id='member' WHERE space_id=$1",[spaces[0]]);
  await sql("UPDATE data.space_members SET role='admin' WHERE space_id=$1 AND user_id='member'",[spaces[0]]);
  await assert.rejects(installs.prepared(request({...pending,actorUserId:"member"})),e=>e.code==="secret_authority_corrupt");
  await confirm(await prepare());const live=await resolve();
  await assert.rejects(new PostgresWeComCompanyRepository(database,"wrong-material").resolve(request({spaceId:spaces[0]})),e=>e.code==="secret_authority_corrupt");
  await sql("UPDATE data.app_wecom_installations SET version=version+1 WHERE space_id=$1",[spaces[0]]);
  await assert.rejects(resolve(),e=>e.code==="secret_authority_corrupt");
  await credentials.put({requestId:crypto.randomUUID(),spaceId:spaces[0],providerId:"wecom",actorUserId:"owner",fields:{webhookKey:"manual-key"},policy:{allowed:["webhookKey"]},at:new Date().toISOString()});
  assert.equal(await companies.current(request({installation:live})),false);
  await confirm(await prepare());await sql("DELETE FROM data.app_connector_connections WHERE space_id=$1",[spaces[0]]);
  assert.equal((await sql("SELECT count(*) FROM data.app_wecom_installations WHERE space_id=$1",[spaces[0]])).rows[0].count,"0");
}));
integration("WeCom suite token renewal is encrypted, lease-serialized and recovers without stale writers",async()=>fixture(async({companies,request,sql,identity})=>{
  const outcomes=await Promise.allSettled([companies.suiteToken(request()),companies.suiteToken(request())]);
  assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);const lease=outcomes.find(r=>r.status==="fulfilled").value;
  await companies.saveSuiteToken(request({...lease,value:"private-suite-token",expiresIn:7200}));
  assert.deepEqual(await companies.suiteToken(request()),{value:"private-suite-token"});
  const row=(await sql("SELECT * FROM data.app_wecom_suite_tokens WHERE app_identity=$1",[identity])).rows[0];assert.doesNotMatch(JSON.stringify(row),/private-suite-token/);
  await assert.rejects(companies.saveSuiteToken(request({...lease,value:"stale-suite-token",expiresIn:7200})),changed);
  await sql("UPDATE data.app_wecom_suite_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE app_identity=$1",[identity]);
  const next=await companies.suiteToken(request());await sql("UPDATE data.app_wecom_suite_tokens SET lease_until=clock_timestamp()-interval '1 second' WHERE app_identity=$1",[identity]);
  const recovered=await companies.suiteToken(request());assert.notEqual(recovered.leaseId,next.leaseId);
  await assert.rejects(companies.saveSuiteToken(request({...next,value:"expired-writer",expiresIn:7200})),changed);
}));

integration("scheduled primary maintenance erases expired prepared codes and keeps a live pending installation",async()=>fixture(async({prepare,sql,spaces,client,installs,request})=>{
  await prepare();const live=await prepare(1);
  await sql("UPDATE data.app_wecom_install_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE space_id=$1",[spaces[0]]);
  const result=await runLifecycleMaintenance(client,parseLifecycleOptions(["--batch-size=1","--max-rows=2"]));
  assert.equal(result.deletedExpiredWeComInstallAttempts,1);
  assert.equal((await sql("SELECT count(*) FROM data.app_wecom_install_attempts WHERE space_id=$1",[spaces[0]])).rows[0].count,"0");
  assert.equal((await installs.prepared(request(live))).spaceId,spaces[1]);
}));
