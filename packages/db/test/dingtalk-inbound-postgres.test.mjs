import assert from "node:assert/strict";
import { integration } from "./postgres-database.fixture.mjs";
import { inboundFixture } from "./dingtalk-inbound.fixture.mjs";
import { PostgresDingTalkInboundConsentRepository,PostgresDingTalkInboundInboxRepository,PostgresDingTalkCompanyRepository } from "../dist/index.js";
const changed = e => e.status===409;
const corrupt = e => e.code==='secret_authority_corrupt';

integration("DingTalk inbound consent is distinct, original-Human one-use and cannot widen native conversation proof",async () => inboundFixture(async f => {
  await assert.rejects(f.accept(await f.message()),changed,"read/send grant is not inbound consent");
  const started = await f.consent.begin(f.request({ selection: f.scope }));
  let proofs = 0;
  const verify = async ({ selection }) => { proofs++;return { ...selection,verifierDigest: f.verifierDigest }; };
  await assert.rejects(f.consent.confirm(f.request({ ...started,confirmed: true,actorUserId: "other" }),verify),changed);
  await assert.rejects(f.consent.confirm(f.request({ ...started,confirmed: true },1),verify),changed);
  const results = await Promise.allSettled([1,2].map(() => f.consent.confirm(f.request({ ...started,confirmed: true }),verify)));
  assert.equal(results.filter(v => v.status==='fulfilled').length,1);assert.equal(proofs,1);
  await assert.rejects(f.consent.confirm(f.request({ ...started,confirmed: true }),verify),changed);
  const second = await f.consent.begin(f.request({ selection: f.scope }));
  await assert.rejects(f.consent.confirm(f.request({ ...second,confirmed: true }),async ({ selection }) => ({ ...selection,
    conversationId: "OtherConversation",verifierDigest: f.verifierDigest })),changed);
  await assert.rejects(f.consent.confirm(f.request({ ...second,confirmed: true }),verify),changed,"failed proof spends state");
  assert.throws(() => new PostgresDingTalkInboundInboxRepository({ ...f.database,cacheMode: 'enabled' },f.key),e => e.status===503);
}));

integration("DingTalk inbound stores private native IDs/text encrypted; conflicting and parallel replay cannot replace work",async () => inboundFixture(async f => {
  await f.inbound();const value = await f.message();
  const results = await Promise.all([f.accept(value),f.accept(value),f.accept(value)]);
  assert.equal(results.filter(v => !v.reused).length,1);assert.equal(results.filter(v => v.reused).length,2);
  const rows = (await f.sql(`SELECT to_jsonb(j) body FROM data.app_dingtalk_inbound_jobs j WHERE app_identity=$1`,[f.identity])).rows;
  const scopes = (await f.sql(`SELECT to_jsonb(s) body FROM data.app_dingtalk_inbound_scopes s WHERE app_identity=$1`,[f.identity])).rows;
  assert.doesNotMatch(JSON.stringify([...rows,...scopes]),/PrivateConversation|PrivateRobot|Private text|MemberCase|dingInbound/);
  await assert.rejects(f.accept({ ...value,text: "Changed private text" }),changed);
  await assert.rejects(f.accept({ ...value,memberId: "OtherMember" }),changed);
  const [job] = await f.inbox.claim(f.request());assert.ok(job);assert.equal('text' in job,false);
  const live = await f.current(job);assert.equal(live.candidate.text,value.text);assert.match(live.sourceRef,/^dingtalk:inbound-[a-f0-9]{64}$/);
  assert.doesNotMatch(live.sourceRef,/MemberCase|PrivateConversation/);
  await f.finish(job,"done");assert.equal(await f.current(job),null);
  assert.deepEqual((await f.sql("SELECT encrypted_value_json FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1",[f.identity])).rows[0].encrypted_value_json,{});
  assert.equal((await f.accept(value)).reused,true);assert.equal((await f.inbox.claim(f.request())).length,0);
}));

integration("DingTalk inbound scope, native provenance and member/company/app identity stay exact",async () => inboundFixture(async f => {
  await f.inbound(); const value = await f.message();
  for (const extra of [{ corpId: 'dingOtherCompany' },{ appId: 1 },{ memberId: 'membercase' },{ robotId: 'WrongRobot' },
    { conversationId: 'WrongConversation' },{ verifierDigest: 'c'.repeat(64) },{ createdAtMs: Date.now()-86400001 },{ createdAtMs: Date.now()+31000 }])
    await assert.rejects(f.accept({ ...value,...extra }),changed);
  assert.equal((await f.sql("SELECT count(*)::int n FROM data.app_dingtalk_inbound_receipts WHERE app_identity=$1",[f.identity])).rows[0].n,0);
  const grant = await f.inbound();await f.accept(await f.message());const [job] = await f.inbox.claim(f.request());
  await f.consent.revoke(f.request({ scopeDigest: grant.scopeDigest }));assert.equal(await f.current(job),null);
  await f.finish(job,'done');assert.equal((await f.sql("SELECT state FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1",[f.identity])).rows[0].state,'obsolete');
}));

integration("DingTalk inbound leases have a global eight-slot bound and expired lease completion cannot finish a successor",async () => inboundFixture(async f => {
  await f.inbound();for (let n=0;n<10;n++) await f.accept(await f.message());
  const claims = await Promise.all([f.inbox.claim(f.request()),f.inbox.claim(f.request())]);
  const jobs = claims.flat();assert.equal(jobs.length,8);assert.equal(new Set(jobs.map(j => j.eventDigest)).size,8);
  const old = jobs[0];
  await f.sql("UPDATE data.app_dingtalk_inbound_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE app_identity=$1 AND event_digest=$2",[f.identity,old.eventDigest]);
  assert.equal(await f.current(old),null);const [successor] = await f.inbox.claim(f.request());assert.ok(successor);
  assert.equal(successor.eventDigest,old.eventDigest);assert.notEqual(successor.leaseId,old.leaseId);
  await f.finish(old,'done');assert.ok(await f.current(successor));
  await f.finish(successor,'retry');assert.equal((await f.inbox.claim(f.request())).some(j => j.eventDigest===successor.eventDigest),false);
}));

integration("DingTalk inbound payload AAD rejects tamper and foreign handles before exposing content",async () => inboundFixture(async f => {
  await f.inbound();await f.parent(1);await f.inbound(1);await f.accept(await f.message());const jobs = await f.inbox.claim(f.request());
  assert.equal(jobs.length,2);const job = jobs[0],other = jobs[1];
  assert.equal(await f.current({ ...job,spaceId: other.spaceId,connectionId: other.connectionId }),null);
  assert.equal(await f.current({ ...job,parentGeneration: crypto.randomUUID() }),null);
  assert.equal(await f.current({ ...job,scopeDigest: 'f'.repeat(64) }),null);
  await assert.rejects(f.current({ ...job,appIdentity: 'wrong-app' }),changed);
  await f.sql(`UPDATE data.app_dingtalk_inbound_jobs SET encrypted_value_json=(SELECT encrypted_value_json FROM data.app_dingtalk_inbound_jobs
    WHERE app_identity=$1 AND connection_id=$2 LIMIT 1) WHERE app_identity=$1 AND connection_id=$3`,[f.identity,other.connectionId,job.connectionId]);
  await assert.rejects(f.current(job),corrupt);
  await assert.rejects(new PostgresDingTalkInboundInboxRepository(f.database,'wrong-key').current(f.request({ job: other })),corrupt);
}));

integration("DingTalk inbound membership removal, visibility replacement, parent reconnect and scope reinstall make old jobs obsolete",async () => inboundFixture(async f => {
  await f.inbound();const message = await f.message();await f.accept(message);const [job] = await f.inbox.claim(f.request());
  const renewed = await f.inbound();assert.notEqual(renewed.inboundGeneration,job.inboundGeneration);assert.equal(await f.current(job),null);
  assert.equal((await f.accept(message)).reused,true,"reinstall cannot adopt accepted event");
  await f.accept(await f.message());const [newJob] = await f.inbox.claim(f.request());assert.ok(newJob);assert.ok(await f.current(newJob));
  await f.sql("UPDATE data.space_members SET version=version+1 WHERE space_id=$1 AND user_id='owner'",[f.spaces[0]]);
  assert.equal(await f.current(newJob),null);await f.inbox.maintain(f.request());
  const rows = (await f.sql("SELECT state,encrypted_value_json FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1",[f.identity])).rows;
  assert.ok(rows.every(r => r.state==='obsolete'));assert.ok(rows.every(r => JSON.stringify(r.encrypted_value_json)==='{}'));
  await f.parent();await f.inbound();await f.accept(await f.message());const [parentJob] = await f.inbox.claim(f.request());
  await f.parent();assert.equal(await f.current(parentJob),null);
  await f.inbound();await f.accept(await f.message());const [visibilityJob] = await f.inbox.claim(f.request());
  await f.visible();assert.equal(await f.current(visibilityJob),null);
}));

integration("DingTalk inbound quota rejection rolls back receipt and every fanout job atomically",async () => inboundFixture(async f => {
  await f.inbound();await f.parent(1);await f.inbound(1);await f.accept(await f.message());
  const id = f.spaces[0]+':dingtalk';
  await f.sql(`INSERT INTO data.app_dingtalk_inbound_receipts(app_identity,event_digest,company_digest,content_digest)
    SELECT app_identity,md5(n::text)||md5('event'||n::text),company_digest,content_digest FROM data.app_dingtalk_inbound_receipts
    CROSS JOIN generate_series(1,254) n WHERE app_identity=$1 LIMIT 254`,[f.identity]);
  await f.sql(`INSERT INTO data.app_dingtalk_inbound_jobs
    SELECT j.app_identity,md5(n::text)||md5('event'||n::text),j.connection_id,j.scope_digest,j.space_id,j.company_digest,j.parent_generation,j.inbound_generation,
      j.actor_user_id,j.actor_membership_generation,j.connection_generation,j.visibility_version,j.content_digest,j.payload_expires_epoch,
      j.encrypted_value_json,j.state,j.attempts,j.available_at,j.lease_id,j.lease_until FROM data.app_dingtalk_inbound_jobs j
    CROSS JOIN generate_series(1,254) n WHERE j.app_identity=$1 AND j.connection_id=$2`,[f.identity,id]);
  const before = (await f.sql("SELECT count(*)::int n FROM data.app_dingtalk_inbound_receipts WHERE app_identity=$1",[f.identity])).rows[0].n;
  const candidates = await Promise.all([f.message(),f.message()]);
  const results = await Promise.allSettled(candidates.map(f.accept));
  assert.equal(results.filter(r => r.status==='fulfilled').length,1);
  assert.equal(results.filter(r => r.status==='rejected' && r.reason.code==='dingtalk_inbound_capacity').length,1);
  assert.equal((await f.sql("SELECT count(*)::int n FROM data.app_dingtalk_inbound_receipts WHERE app_identity=$1",[f.identity])).rows[0].n,before+1);
  assert.equal((await f.sql("SELECT count(*)::int n FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1 AND connection_id=$2",[f.identity,id])).rows[0].n,256);
  assert.equal((await f.sql("SELECT count(*)::int n FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1 AND connection_id=$2",[f.identity,f.spaces[1]+':dingtalk'])).rows[0].n,2);
}));

function holdQuery(database,name) {
  let release,entered;
  const waiting = new Promise(resolve => { release=resolve; }),seen = new Promise(resolve => { entered=resolve; });
  return { release,seen,database: { ...database,transaction: (context,run) => database.transaction(context,tx => run({
    query: async query => { const result = await tx.query(query);if (query.name===name) { entered();await waiting; }return result; }
  })) } };
}
async function assertWaiting(f,pattern="SELECT pg_advisory_xact_lock%") {
  const until = Date.now()+1500;
  do { const rows = (await f.sql(`SELECT pid FROM pg_stat_activity WHERE application_name='dingtalk-inbound-boundary'
    AND wait_event_type='Lock' AND query LIKE $1`,[pattern])).rows;
    if (rows.length) return;
    await new Promise(resolve => setTimeout(resolve,10));
  } while (Date.now()<until);
  assert.fail('Expected a physically observed primary advisory-lock waiter');
}
integration("DingTalk inbound acceptance and retirement serialize in both physically observed lock orders",async () => {
  await inboundFixture(async f => {
    await f.inbound();const value = await f.message(),hold = holdQuery(f.database,'dingtalk_inbound_job_insert_v1');
    const accepting = new PostgresDingTalkInboundInboxRepository(hold.database,f.key).accept(f.request({ candidate: value }));
    try {
      await hold.seen;const retiring = f.companies.retire(f.request({ corpId: f.selection.corpId,eventTime: await f.time() }));
      await assertWaiting(f);hold.release();await accepting;await retiring;
      assert.equal((await f.inbox.claim(f.request())).length,0);
      const row = (await f.sql('SELECT state,encrypted_value_json FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1',[f.identity])).rows[0];
      assert.equal(row.state,'obsolete');assert.deepEqual(row.encrypted_value_json,{});
    } finally { hold.release();await accepting.catch(() => {}); }
  });
  await inboundFixture(async f => {
    await f.inbound();const value = await f.message(),hold = holdQuery(f.database,'dingtalk_fence_save_v1');
    const retiring = new PostgresDingTalkCompanyRepository(hold.database,f.key).retire(f.request({ corpId: f.selection.corpId,eventTime: await f.time() }));
    try {
      await hold.seen;const accepting = f.accept(value);const rejected = assert.rejects(accepting,changed);
      await assertWaiting(f);hold.release();await retiring;await rejected;
      assert.equal((await f.sql('SELECT count(*)::int n FROM data.app_dingtalk_inbound_receipts WHERE app_identity=$1',[f.identity])).rows[0].n,0);
    } finally { hold.release();await retiring.catch(() => {}); }
  });
});

integration("DingTalk inbound five attempts, payload erasure and bounded seven-day receipt cleanup survive abandoned drainers",async () => inboundFixture(async f => {
  await f.inbound();await f.accept(await f.message());
  for (let n=0;n<5;n++) { const [job] = await f.inbox.claim(f.request());assert.ok(job);await f.finish(job,'retry');
    await f.sql("UPDATE data.app_dingtalk_inbound_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE app_identity=$1",[f.identity]); }
  let row = (await f.sql("SELECT state,encrypted_value_json FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1",[f.identity])).rows[0];
  assert.equal(row.state,'failed');assert.deepEqual(row.encrypted_value_json,{});assert.equal((await f.inbox.claim(f.request())).length,0);
  for (let n=0;n<12;n++) await f.accept(await f.message());
  await f.sql("UPDATE data.app_dingtalk_inbound_jobs SET payload_expires_epoch=1 WHERE app_identity=$1 AND state='pending'",[f.identity]);
  await f.inbox.maintain(f.request());
  assert.equal((await f.sql("SELECT count(*)::int n FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1 AND state='pending'",[f.identity])).rows[0].n,4);
  await f.inbox.maintain(f.request());
  await f.sql("UPDATE data.app_dingtalk_inbound_receipts SET retain_until=clock_timestamp()-interval '1 second' WHERE app_identity=$1",[f.identity]);
  await f.inbox.maintain(f.request());
  assert.equal((await f.sql("SELECT count(*)::int n FROM data.app_dingtalk_inbound_receipts WHERE app_identity=$1",[f.identity])).rows[0].n,5);
  await f.inbox.maintain(f.request());assert.equal((await f.sql("SELECT count(*)::int n FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1",[f.identity])).rows[0].n,0);
}));

integration("DingTalk inbound provider proof cannot confirm after company retirement",async () => inboundFixture(async f => {
  const started = await f.consent.begin(f.request({ selection: f.scope }));
  const stored = (await f.sql("SELECT encrypted_value_json FROM data.app_dingtalk_inbound_attempts WHERE connection_id=$1",[f.spaces[0]+':dingtalk'])).rows[0];
  await assert.rejects(f.consent.confirm(f.request({ ...started,confirmed: true }),async ({ selection }) => {
    await f.companies.retire(f.request({ corpId: f.selection.corpId,eventTime: await f.time() }));return { ...selection,verifierDigest: f.verifierDigest };
  }),changed);
  assert.equal((await f.sql("SELECT count(*)::int n FROM data.app_dingtalk_inbound_scopes WHERE app_identity=$1",[f.identity])).rows[0].n,0);
  assert.ok(stored.encrypted_value_json);
}));

integration('DingTalk cleanup child locks never survive into begin/accept company waits; claim/maintain also release retirement FK waits',async () => {
  for (const operation of ['begin','accept','claim','maintain']) await inboundFixture(async f => {
    await f.inbound();await f.accept(await f.message());
    await f.consent.begin(f.request({ selection: f.scope }));
    await f.sql("UPDATE data.app_dingtalk_inbound_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE app_identity=$1",[f.identity]);
    const hold=holdQuery(f.database,'dingtalk_inbound_attempt_cleanup_v1');
    const consent=new PostgresDingTalkInboundConsentRepository(hold.database,f.key),inbox=new PostgresDingTalkInboundInboxRepository(hold.database,f.key);
    const input=f.request(),candidate=await f.message();
    const doing=(operation==='begin' ? consent.begin({ ...input,selection: f.scope }) :
      operation==='accept' ? inbox.accept({ ...input,candidate }) : inbox[operation](input));
    const settled=doing.then(value => ({value}),error => ({error}));
    try {
      await hold.seen;
      const retiring=f.companies.retire(f.request({ corpId: f.selection.corpId,eventTime: await f.time() }));
      const retired=retiring.then(value => ({value}),error => ({error}));
      await assertWaiting(f,'DELETE FROM data.app_dingtalk_company_grants%');
      hold.release();const [a,b]=await Promise.all([settled,retired]);
      assert.equal(b.error,undefined,operation+' must not deadlock retirement');
      if (a.error) assert.equal(a.error.status,409,operation+' may only reject changed authorization');
      const claimed=await f.inbox.claim(f.request());assert.equal(claimed.length,0);
    } finally { hold.release();await settled; }
  });
});

integration('DingTalk begin/revoke/confirm/current wait for retirement before parent or child locks and do not adopt old authority',async () => {
  for (const operation of ['begin','revoke','confirm','current']) await inboundFixture(async f => {
    const grant=await f.inbound();await f.accept(await f.message());const [job]=await f.inbox.claim(f.request());
    const started=await f.consent.begin(f.request({ selection: f.scope }));
    const hold=holdQuery(f.database,'dingtalk_fence_save_v1');
    const retiring=new PostgresDingTalkCompanyRepository(hold.database,f.key).retire(f.request({ corpId: f.selection.corpId,eventTime: await f.time() }));
    try {
      await hold.seen;
      const doing=operation==='begin' ? f.consent.begin(f.request({ selection: f.scope })) :
        operation==='revoke' ? f.consent.revoke(f.request({ scopeDigest: grant.scopeDigest })) :
        operation==='confirm' ? f.consent.confirm(f.request({ ...started,confirmed: true }),async () => { assert.fail('retired native proof must not run'); }) : f.current(job);
      const rejected=operation==='current' ? doing.then(value => assert.equal(value,null)) : assert.rejects(doing,changed);
      await assertWaiting(f);hold.release();await retiring;await rejected;
    } finally { hold.release();await retiring.catch(() => {}); }
  });
});

integration('DingTalk retirement supersedes retry exhaustion when cleanup terminal causes overlap',async () => inboundFixture(async f => {
  await f.inbound();await f.accept(await f.message());await f.inbox.claim(f.request());
  await f.sql("UPDATE data.app_dingtalk_inbound_jobs SET attempts=5,lease_until=clock_timestamp()-interval '1 second' WHERE app_identity=$1",[f.identity]);
  await f.companies.retire(f.request({ corpId: f.selection.corpId,eventTime: await f.time() }));
  await f.inbox.maintain(f.request());
  const row=(await f.sql('SELECT state,encrypted_value_json FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1',[f.identity])).rows[0];
  assert.equal(row.state,'obsolete');assert.deepEqual(row.encrypted_value_json,{});
}));

integration('DingTalk retirement holding FK child deletions allows cleanup to finish before begin/accept company waits',async () => {
  for (const operation of ['begin','accept']) await inboundFixture(async f => {
    await f.inbound();await f.consent.begin(f.request({ selection: f.scope }));
    await f.sql("UPDATE data.app_dingtalk_inbound_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE app_identity=$1",[f.identity]);
    const candidate=await f.message(),hold=holdQuery(f.database,'dingtalk_retire_private_v1');
    const retiring=new PostgresDingTalkCompanyRepository(hold.database,f.key).retire(f.request({ corpId: f.selection.corpId,eventTime: await f.time() }));
    try {
      await hold.seen;
      const doing=operation==='begin' ? f.consent.begin(f.request({ selection: f.scope })) : f.accept(candidate);
      const rejected=assert.rejects(doing,changed);
      await assertWaiting(f);hold.release();await retiring;await rejected;
      assert.equal((await f.sql('SELECT count(*)::int n FROM data.app_dingtalk_inbound_attempts WHERE app_identity=$1',[f.identity])).rows[0].n,0);
    } finally { hold.release();await retiring.catch(() => {}); }
  });
});
