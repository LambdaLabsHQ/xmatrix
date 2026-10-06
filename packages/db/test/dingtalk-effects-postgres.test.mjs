import assert from 'node:assert/strict';
import { Client } from 'pg';
import { PostgresMessageRepository,PostgresAutomationRepository,PostgresDingTalkCompanyRepository,PostgresDingTalkInboundConsentRepository } from '../dist/index.js';
import { connectionString,integration } from './postgres-database.fixture.mjs';
import { effectFixture,pauseQuery } from './dingtalk-effects.fixture.mjs';

const denied=e=>[403,404,409,503].includes(e.status) || (e.name==='DatabaseContractError' && e.message==='placement shard does not match the selected database');
const count=async f=>Number((await f.sql('SELECT count(*) n FROM data.messages WHERE space_id=$1',[f.spaceId])).rows[0].n);
async function operation(f,kind,authority,db=f.database) {
  return kind==='channel' ? new PostgresMessageRepository(db).append(await f.appendInput(authority),authority)
    : new PostgresAutomationRepository(db).fireTrigger(await f.fireInput(authority),authority);
}
async function waiting(f,needle) {
  const deadline=Date.now()+1500;
  while(Date.now()<deadline) {
    const rows=(await f.sql(`SELECT query FROM pg_stat_activity WHERE application_name=$1
      AND wait_event_type='Lock'`,[f.applicationName])).rows;
    if(rows.some(r=>r.query.includes(needle))) return;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.fail('Expected actual PostgreSQL lock wait: '+needle);
}

integration('DingTalk true append/fire owners consume opaque source capabilities and independent current target authority',async()=>effectFixture(async f=>{
  const cap=await f.cap(),input=await f.appendInput(cap);
  await assert.rejects(f.messages.append(input,JSON.parse(JSON.stringify(cap))),denied);
  await assert.rejects(f.messages.append({...input,principal:{kind:'user',id:'other'}},cap),denied);
  await assert.rejects(f.messages.append({...input,prepared:{...input.prepared,bodyHash:'f'.repeat(64)}},cap),denied);
  const result=await f.messages.append(input,cap);assert.equal(result.messageId,cap.effectId);assert.equal(await count(f),1);
  assert.deepEqual(await f.messages.append(input,cap),result);
  const ac=await f.cap('automation');assert.notEqual(ac.effectId,cap.effectId);
  assert.equal(await operation(f,'automation',ac),f.channelId);
  const stored=(await f.sql('SELECT trigger_events FROM data.automations WHERE automation_id=$1',[f.automationId])).rows[0];
  assert.equal(stored.trigger_events[0].summary,f.source.candidate.text);
  assert.equal(stored.trigger_events[0].id,ac.effectId);
  const fresh=await f.cap('automation');assert.equal(fresh.effectId,ac.effectId);
  assert.equal(await operation(f,'automation',fresh),null);
  await f.companies.retire(f.request({ eventTime:await f.time(),corpId:f.selection.corpId,appId:f.selection.appId }));
  await assert.rejects(f.messages.append(input,cap),denied,'historical success cannot admit a retired source');
  await assert.rejects(operation(f,'automation',fresh),denied);
}));

for(const kind of ['channel','automation']) {
  for(const revoke of ['acl','member']) integration(`DingTalk ${kind} rejects ${revoke} revocation that committed while its owner waited`,async()=>effectFixture(async f=>{
    const cap=await f.cap(kind),input=kind==='channel'?await f.appendInput(cap):await f.fireInput(cap);
    const peer=new Client({connectionString});await peer.connect();
    try {
      await peer.query('BEGIN');
      if(revoke==='acl') {
        await peer.query('SELECT 1 FROM data.channels WHERE channel_id=$1 FOR UPDATE',[f.channelId]);
        await peer.query("DELETE FROM data.channel_access WHERE channel_id=$1 AND subject_id='target'",[f.channelId]);
        await peer.query('UPDATE data.channels SET version=version+1 WHERE channel_id=$1',[f.channelId]);
      } else {
        await peer.query("SELECT 1 FROM data.space_members WHERE space_id=$1 AND user_id='target' FOR UPDATE",[f.spaceId]);
        await peer.query("UPDATE data.space_members SET role='viewer',version=version+1 WHERE space_id=$1 AND user_id='target'",[f.spaceId]);
      }
      const pending=kind==='channel'?f.messages.append(input,cap):f.automations.fireTrigger(input,cap);
      const rejection=assert.rejects(pending,denied); // Observe rejection before releasing a blocker.
      await waiting(f,revoke==='acl'?'data.channels':'data.space_members');
      await peer.query('COMMIT');await rejection;
      assert.equal(await count(f),0);
      assert.equal((await f.sql('SELECT trigger_events FROM data.automations WHERE automation_id=$1',[f.automationId])).rows[0].trigger_events,null);
    } finally { await peer.query('ROLLBACK');await peer.end(); }
  }));

  for(const revoke of ['acl','member']) integration(`DingTalk ${kind} effect holds ${revoke} authority until its physical commit`,async()=>effectFixture(async f=>{
    const cap=await f.cap(kind),input=kind==='channel'?await f.appendInput(cap):await f.fireInput(cap);
    const pause=pauseQuery(f.database,kind==='channel'?'dingtalk_effect_relation_v1':'automation_trigger_lock_v1');
    const pending=kind==='channel'?new PostgresMessageRepository(pause.database).append(input,cap)
      :new PostgresAutomationRepository(pause.database).fireTrigger(input,cap);
    await pause.waiting;const peer=new Client({connectionString,application_name:f.applicationName});await peer.connect();
    try {
      await peer.query('BEGIN');
      const blocked=peer.query(revoke==='acl'?'SELECT 1 FROM data.channels WHERE channel_id=$1 FOR UPDATE'
        :"SELECT 1 FROM data.space_members WHERE space_id=$1 AND user_id='target' FOR UPDATE",[revoke==='acl'?f.channelId:f.spaceId]);
      await waiting(f,revoke==='acl'?'data.channels':'data.space_members');
      pause.release();await pending;await blocked;
      if(revoke==='acl') await peer.query("DELETE FROM data.channel_access WHERE channel_id=$1 AND subject_id='target'",[f.channelId]);
      else await peer.query("UPDATE data.space_members SET role='viewer',version=version+1 WHERE space_id=$1 AND user_id='target'",[f.spaceId]);
      await peer.query('COMMIT');
      await assert.rejects(kind==='channel'?f.messages.append(input,cap):f.automations.fireTrigger(input,cap),denied);
    } finally {pause.release();await peer.query('ROLLBACK');await peer.end();}
  }));
}

integration('DingTalk changed relation/features/Automation owner/enabled and foreign physical placement fail closed',async()=>effectFixture(async f=>{
  const cap=await f.cap(),input=await f.appendInput(cap);
  await f.sql("UPDATE data.app_source_relations SET features_json='[]',version=version+1 WHERE relation_id=$1",[f.relationId]);
  await assert.rejects(f.messages.append(input,cap),denied);
  const ac=await f.cap('automation'),ai=await f.fireInput(ac);
  await f.sql('UPDATE data.automations SET enabled=false,version=version+1 WHERE automation_id=$1',[f.automationId]);
  await assert.rejects(f.automations.fireTrigger(ai,ac),denied);
  await f.sql("UPDATE data.automations SET enabled=true,owner_user_id='other' WHERE automation_id=$1",[f.automationId]);
  await assert.rejects(f.automations.fireTrigger(ai,ac),denied);
  await f.sql("INSERT INTO control.postgres_shards(shard_id,state,capacity_class,created_at,updated_at) VALUES($1,'active','test',now(),now())",[f.spaceId]);
  await f.sql('UPDATE control.space_placement SET shard_id=$2,placement_epoch=placement_epoch+1 WHERE space_id=$1',[f.spaceId,f.spaceId]);
  await assert.rejects(f.automations.fireTrigger(ai,ac),denied);
  assert.equal(await count(f),0);
}));

for(const kind of ['channel','automation']) integration(`DingTalk ${kind} late cancellation rolls back new writes and rejects actual replay early return`,async()=>effectFixture(async f=>{
  const controller=new AbortController(),cap=await f.cap(kind,controller.signal),input=kind==='channel'?await f.appendInput(cap):await f.fireInput(cap);
  const pause=pauseQuery(f.database,kind==='channel'?'message_append_publish_unmetered_v1':'automation_replay_write_v1',()=>controller.abort());
  const pending=kind==='channel'?new PostgresMessageRepository(pause.database).append(input,cap):new PostgresAutomationRepository(pause.database).fireTrigger(input,cap);
  const rejection=assert.rejects(pending,denied);
  await pause.waiting;pause.release();await rejection;
  assert.equal(await count(f),0);
}));

for(const kind of ['channel','automation']) for(const late of ['abort','lease']) integration(`DingTalk ${kind} actual replay path rejects late ${late}`,async()=>effectFixture(async f=>{
  const first=await f.cap(kind);await operation(f,kind,first);
  const controller=new AbortController(),cap=await f.cap(kind,controller.signal),input=kind==='channel'?await f.appendInput(cap):await f.fireInput(cap);
  if(late==='lease') await f.sql("UPDATE data.app_dingtalk_inbound_jobs SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE app_identity=$1",[f.identity]);
  const pause=pauseQuery(f.database,kind==='channel'?'message_append_preflight_v4':'automation_trigger_seen_v1');
  const pending=kind==='channel'?new PostgresMessageRepository(pause.database).append(input,cap):new PostgresAutomationRepository(pause.database).fireTrigger(input,cap);
  const rejection=assert.rejects(pending,denied);await pause.waiting;
  if(late==='abort') controller.abort();else await new Promise(r=>setTimeout(r,550));
  pause.release();await rejection;
  assert.equal(await count(f),kind==='channel'?1:0);
}));

for(const kind of ['channel','automation']) for(const retirement of ['retire','revoke','rotate']) for(const order of ['retirement-first','effect-first'])
  integration(`DingTalk actual ${kind} ${retirement} ${order} serializes at the source company lock`,async()=>effectFixture(async f=>{
    const cap=await f.cap(kind),input=kind==='channel'?await f.appendInput(cap):await f.fireInput(cap);
    const started=retirement==='rotate'?await f.consent.begin(f.request({selection:f.scope})):undefined;
    const pause=pauseQuery(f.database,order==='retirement-first'?(retirement==='rotate'?'dingtalk_inbound_scope_confirm_v1':'dingtalk_company_lock_v1'):kind==='channel'?'dingtalk_effect_relation_v1':'automation_trigger_lock_v1');
    const retire=async db=> retirement==='retire' ? new PostgresDingTalkCompanyRepository(db,f.key).retire(f.request({eventTime:await f.time(),corpId:f.selection.corpId,appId:f.selection.appId}))
      :retirement==='revoke'?new PostgresDingTalkInboundConsentRepository(db,f.key).revoke(f.request({scopeDigest:f.job.scopeDigest}))
      :new PostgresDingTalkInboundConsentRepository(db,f.key).confirm(f.request({...started,confirmed:true}),async({selection})=>({...selection,verifierDigest:f.verifierDigest}));
    if(order==='retirement-first') {
      const retiring=retire(pause.database);await pause.waiting;
      const pending=kind==='channel'?f.messages.append(input,cap):f.automations.fireTrigger(input,cap);
      const rejected=assert.rejects(pending,denied);await waiting(f,'pg_advisory_xact_lock');pause.release();await retiring;await rejected;
      assert.equal(await count(f),0);
      assert.equal((await f.sql('SELECT trigger_events FROM data.automations WHERE automation_id=$1',[f.automationId])).rows[0].trigger_events,null);
    } else {
      const pending=kind==='channel'?new PostgresMessageRepository(pause.database).append(input,cap):new PostgresAutomationRepository(pause.database).fireTrigger(input,cap);
      await pause.waiting;const retiring=retire(f.database);await waiting(f,'pg_advisory_xact_lock');pause.release();await pending;await retiring;
      await assert.rejects(kind==='channel'?f.messages.append(input,cap):f.automations.fireTrigger(input,cap),denied);
    }
}));

integration('DingTalk primary candidate enumeration binds stable IDs and excludes unmatched triggers',async()=>effectFixture(async f=>{
  assert.deepEqual(await f.inbox.effectDestinations(f.request({job:f.job,kind:'channel'})),[await f.destination('channel')]);
  assert.deepEqual(await f.inbox.effectDestinations(f.request({job:f.job,kind:'automation'})),[await f.destination('automation')]);
  await f.sql(`UPDATE data.automations SET payload_json=jsonb_set(payload_json,'{triggers}','[{"kind":"event","provider":"dingtalk","source":"wrong"}]') WHERE automation_id=$1`,[f.automationId]);
  assert.deepEqual(await f.inbox.effectDestinations(f.request({job:f.job,kind:'automation'})),[]);
}));

for(const kind of ['channel','automation']) for(const prior of ['absent','deleted-while-waiting'])
  integration(`DingTalk actual ${kind} refuses ${prior} target even if it rejoins after a zero-row member lock`,async()=>effectFixture(async f=>{
    const cap=await f.cap(kind),input=kind==='channel'?await f.appendInput(cap):await f.fireInput(cap);
    const peer=new Client({connectionString});await peer.connect();
    const pause=pauseQuery(f.database,'dingtalk_effect_member_lock_v1',undefined,q=>q.values[1]==='target');
    try {
      if(prior==='deleted-while-waiting') await peer.query('BEGIN');
      await peer.query("DELETE FROM data.space_members WHERE space_id=$1 AND user_id='target'",[f.spaceId]);
      const pending=kind==='channel'?new PostgresMessageRepository(pause.database).append(input,cap):new PostgresAutomationRepository(pause.database).fireTrigger(input,cap);
      const rejection=assert.rejects(pending,denied);
      if(prior==='deleted-while-waiting') {await waiting(f,'data.space_members');await peer.query('COMMIT');}
      await pause.waiting;
      await peer.query("INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at) VALUES($1,'target','member',1,now(),now())",[f.spaceId]);
      pause.release();await rejection;
      assert.equal(await count(f),0);
      assert.equal((await f.sql('SELECT trigger_events FROM data.automations WHERE automation_id=$1',[f.automationId])).rows[0].trigger_events,null);
    } finally {pause.release();await peer.query('ROLLBACK');await peer.end();}
}));
