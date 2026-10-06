import { connectorDatabase } from "./postgres-database.fixture.mjs";
import { PostgresDingTalkInstallRepository,PostgresDingTalkVisibilityRepository,PostgresDingTalkCompanyRepository,
  PostgresDingTalkInboundConsentRepository,PostgresDingTalkInboundInboxRepository,dingtalkAppIdentity } from "../dist/index.js";

/** Isolated implementation fixtures only: no registration values, native proof or provider call. */
export async function inboundFixture(run) {
  const { client,database,sql } = await connectorDatabase("dingtalk-inbound-boundary");
  const spaces = ["dt-inbound-"+crypto.randomUUID(),"dt-inbound-"+crypto.randomUUID()];
  const app = { suiteKey: "suite"+crypto.randomUUID().replaceAll("-",""),eventKeyDigest: "a".repeat(64) },
    identity = dingtalkAppIdentity(app),key = "inbound-implementation-test-key";
  const selection = { corpId: "dingInboundPrivateFixture",appId: 42424,members: ["MemberCase"] },
    scope = { memberId: "MemberCase",robotId: "$:PrivateRobotFixture",conversationId: "PrivateConversationFixture",conversationType: "direct" },
    verifierDigest = "b".repeat(64);
  const installs = new PostgresDingTalkInstallRepository(database,key),visibility = new PostgresDingTalkVisibilityRepository(database,key),
    companies = new PostgresDingTalkCompanyRepository(database,key),consent = new PostgresDingTalkInboundConsentRepository(database,key),
    inbox = new PostgresDingTalkInboundInboxRepository(database,key);
  const request = (extra = {},n = 0) => ({ app,requestId: crypto.randomUUID(),actorUserId: "owner",spaceId: spaces[n],...extra });
  const time = async () => (await sql("SELECT clock_timestamp() at")).rows[0].at.toISOString();
  const candidate = async (extra = {}) => ({ ...scope,verifierDigest,...selection,members: undefined,
    providerMessageId: "PrivateMessage"+crypto.randomUUID(),createdAtMs: Number((await sql("SELECT ceil(extract(epoch from clock_timestamp())*1000)::bigint at")).rows[0].at),
    text: "Private text fixture",mentioned: false,...extra });
  const message = async extra => { const { members: _members,...value } = await candidate(extra); return value; };
  const visible = () => visibility.accept(request({ eventTime: new Date().toISOString(),scope: {
    corpId: selection.corpId,appId: selection.appId,agentId: 43434,users: selection.members,departments: [] } }));
  const parent = async (n = 0) => {
    const started = await installs.begin(request({ selection },n));
    await installs.take(request(started,n));
    await installs.verify(request({ ...started,grant: { ...selection,agentId: 43434,nativeAdminId: "AdminFixtureOnly" } },n));
    await installs.confirm(request({ ...started,confirmed: true },n));
    return companies.resolve(request({},n));
  };
  const inbound = async (n = 0,selected = scope) => {
    const started = await consent.begin(request({ selection: selected },n));
    return consent.confirm(request({ ...started,confirmed: true },n),async ({ selection }) => ({ ...selection,verifierDigest }));
  };
  const accept = value => inbox.accept(request({ candidate: value }));
  const current = job => inbox.current(request({ job }));
  const finish = (job,outcome) => inbox.finish(request({ job,outcome }));
  try {
    for (const space of spaces) {
      await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
        VALUES($1,'owner','owner',1,clock_timestamp(),clock_timestamp()),($1,'other','admin',1,clock_timestamp(),clock_timestamp())`,[space]);
      await sql(`INSERT INTO data.app_connector_connections(connection_id,space_id,provider_id,provider_name,status,
        auth_mode,scopes_json,secret_refs_json,capabilities_json,channel_ids_json,created_by,search_rank_sequence,version,created_at,updated_at)
        VALUES($1||':dingtalk',$1,'dingtalk','DingTalk','disconnected','api-token','[]','[]','[]','[]','owner',$1||':birth',1,clock_timestamp(),clock_timestamp())`,[space]);
    }
    await visible(); await parent();
    await run({ client,database,sql,app,identity,key,spaces,selection,scope,verifierDigest,installs,companies,consent,inbox,
      request,time,message,visible,parent,inbound,accept,current,finish });
  } finally {
    await sql("DELETE FROM data.app_dingtalk_inbound_receipts WHERE app_identity=$1",[identity]);
    for (const table of ["app_dingtalk_company_fences","app_dingtalk_company_visibility"])
      await sql(`DELETE FROM data.${table} WHERE app_identity=$1`,[identity]);
    for (const table of ["app_connector_connections","space_members","space_deletions"])
      await sql(`DELETE FROM data.${table} WHERE space_id=ANY($1::text[])`,[spaces]);
    await database.close?.(); await client.end();
  }
}
