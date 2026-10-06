import {Client} from 'pg';
import {digestCanonicalCloneCborV1} from '@xmatrix/protocol';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveTestPostgresTools} from '../../../scripts/test-postgres-tools.mjs';
import {createAuthorityDatabase,PostgresDingTalkInboundInboxRepository,PostgresMessageRepository,PostgresAutomationRepository} from '../dist/index.js';
import {effectFixture} from './dingtalk-effects.fixture.mjs';
import {DingTalkEffectCoordinator,dingtalkPrivateCoordinationProof} from '../dist/dingtalk-effect-coordinator.js';
import {dingtalkPrivatePreparedPath} from '../dist/dingtalk-prepared-port.js';
export const serversFile=process.env.XMATRIX_DINGTALK_CROSSDB_SERVERS;
export async function crossFixture(run,options={}) {
  if(!serversFile)throw new Error('two independently started PostgreSQL servers are required');
  const modules={createAuthorityDatabase,PostgresDingTalkInboundInboxRepository,PostgresMessageRepository,PostgresAutomationRepository,DingTalkEffectCoordinator,dingtalkPrivateCoordinationProof,dingtalkPrivatePreparedPath,...options.modules};
  const servers=JSON.parse(await readFile(serversFile,'utf8'));
  return effectFixture(async f=>{
    let peer=new Client({connectionString:servers.target.url});await peer.connect();
    const sql=async(text,values=[])=>peer.query(text,values);
    const tables=['spaces','space_members','space_control_heads','channels','channel_access','app_source_relations','automations'];
    for(const table of tables) {
      const rows=(await f.sql(`SELECT row_to_json(t) AS snapshot FROM data.${table} t WHERE ${table==='automations'?'automation_id':'space_id'}=$1`,[table==='automations'?f.automationId:f.spaceId])).rows.map(row=>row.snapshot);
      for(const row of rows)await sql(`INSERT INTO data.${table} SELECT * FROM jsonb_populate_record(NULL::data.${table},$1::jsonb)`,[JSON.stringify(row)]);
    }
    await sql(`INSERT INTO control.space_placement(space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
      VALUES($1,'shard-1',1,'active','test',now(),now())`,[f.spaceId]);
    const identity=side=>({shardId:servers[side].shard,databaseName:servers[side].admin,roleName:servers[side].role});
    const path=side=>modules.dingtalkPrivatePreparedPath({pathId:'private-test-direct:'+servers[side].data,...identity(side),twoPhase:true,retainedSerialization:true,recoveryOwner:'isolated-test-manager',evidenceDigest:'c'.repeat(64)});
    const db=side=>modules.createAuthorityDatabase({connectionString:servers[side].runtimeUrl,shardId:servers[side].shard,
      applicationName:'dt-cross:'+f.spaceId,statementTimeoutMs:5000,transactionTimeoutMs:10000,lockTimeoutMs:2000,
      ...(options.clientFactory?{clientFactory:config=>options.clientFactory(side,config)}:{})});
    const primary=db('source'),target=db('target'),inbox=new modules.PostgresDingTalkInboundInboxRepository(primary,f.key);
    const sourceOwner={database:options.sourceDatabase?.(primary)??primary,identity:identity('source'),path:options.unknown?undefined:path('source')};
    const targetOwner={database:options.targetDatabase?.(target)??target,identity:identity('target'),path:options.unknown?undefined:path('target')};
    const coordinator=new modules.DingTalkEffectCoordinator(sourceOwner,targetOwner,inbox,f.app);
    const proof=()=>modules.dingtalkPrivateCoordinationProof(f.job,f.verifierDigest,Date.now()+20000);
    const appendInput=async authority=>{
      const reservation=await new modules.PostgresMessageRepository(target).reserveAppendSequence({requestId:crypto.randomUUID(),commandId:authority.effectId,spaceId:f.spaceId,channelId:f.channelId,observedPostgresHead:0});
      return {requestId:crypto.randomUUID(),commandId:authority.effectId,messageId:authority.effectId,spaceId:f.spaceId,channelId:f.channelId,sequence:reservation.sequence,
        principal:{kind:'user',id:'target'},senderKind:'app',senderId:'dingtalk',messageKind:'xmatrix.message.text',sentAt:await f.time(),requestDigest:'1'.repeat(64),
        senderSnapshot:{kind:'app',id:'dingtalk'},attentionBody:f.source.candidate.text,prepared:{codecId:'canonical-clone-cbor-v1',payloadSchemaVersion:1,
        fieldPresenceBase64:'AA',payloadBundleBase64:'AA',bodyHash:await digestCanonicalCloneCborV1(f.source.candidate.text),senderSnapshotDigest:'3'.repeat(64),recordDigest:'4'.repeat(64),recordEncodedBytes:10,
        preview:{bodyPreview:f.source.candidate.text,senderSnapshot:{kind:'app',id:'dingtalk'}}}};
    };
    const execute=async(kind='channel',extra={})=>coordinator.execute({job:f.job,destination:await f.destination(kind),proof:await proof(),signal:new AbortController().signal,
      runTarget:async(database,authority)=>{
        if(kind==='channel')await new modules.PostgresMessageRepository(database).append(await appendInput(authority),authority);
        else await new modules.PostgresAutomationRepository(database).fireTrigger(await f.fireInput(authority),authority);
      },...extra});
    const count=async()=>Number((await sql('SELECT count(*) n FROM data.messages WHERE space_id=$1',[f.spaceId])).rows[0].n);
    const trigger=async()=>(await sql('SELECT trigger_events FROM data.automations WHERE automation_id=$1',[f.automationId])).rows[0].trigger_events;
    const journals=async()=>(await f.sql("SELECT * FROM control.dingtalk_effect_journal WHERE binding_json->'job'->>'spaceId'=$1",[f.spaceId])).rows;
    const restart=async side=>{
      if(side==='source')await f.client.end();else await peer.end();
      const tools=resolveTestPostgresTools();
      await promisify(execFile)(tools.pg_ctl,['-D',servers[side].data,'-l',servers[side].data+'/restart.log','-m','fast','-w','restart'],{timeout:30000});
      const next=new Client({connectionString:servers[side].url});await next.connect();
      if(side==='source'){f.client.query=(...args)=>next.query(...args);f.client.end=()=>next.end();}else peer=next;
    };
    try {await run({...f,restart,appendInput,sourceSql:f.sql,servers,sql,primary,target,sourceOwner,targetOwner,inbox,coordinator,execute,proof,count,trigger,journals});}
    finally {
      const pending=(await journals()).filter(r=>!['committed','aborted'].includes(r.state));
      for(const row of pending) {
        await f.sql("UPDATE control.dingtalk_effect_journal SET leader_until=clock_timestamp()-interval '1 second' WHERE binding_digest=$1",[row.binding_digest]);
        await coordinator.recover(row.binding_digest);
      }
      // No prefix inventory rollback. Only exact decisions registered by this fixture.
      for(const row of await journals()) {
        for(const side of ['s','t']) {
          const q=side==='s'?f.sql:sql,gid=`xmatrix:dtfx:${row.binding_digest}:1:${side}`;
          await q('DELETE FROM control.dingtalk_effect_outcomes WHERE gid=$1',[gid]);
          await q('DELETE FROM control.dingtalk_effect_gates WHERE gid=$1',[gid]);
        }
        await f.sql('DELETE FROM control.dingtalk_effect_journal WHERE binding_digest=$1',[row.binding_digest]);
      }
      for(const table of ['automations','app_source_relations','message_sequence_reservations','message_mutations','message_attention','message_attention_revisions','messages','idempotency_keys','outbox','channel_content_counters','channel_message_sequences','channel_access','space_control_heads','channels','space_members','spaces'])
        await sql(`DELETE FROM data.${table} WHERE ${table==='automations'?'automation_id':'space_id'}=$1`,[table==='automations'?f.automationId:f.spaceId]);
      await sql("DELETE FROM control.scoped_control_command_replays WHERE scope_kind='space' AND scope_id=$1",[f.spaceId]);
      await sql('DELETE FROM control.space_placement WHERE space_id=$1',[f.spaceId]);await peer.end();
    }
  },{PostgresDingTalkInboundInboxRepository:modules.PostgresDingTalkInboundInboxRepository});
}
export async function waitLock(sql,needle) {
  const until=Date.now()+1500;
  while(Date.now()<until){if((await sql("SELECT query FROM pg_stat_activity WHERE wait_event_type='Lock'")).rows.some(r=>r.query.includes(needle)))return;
    await new Promise(r=>setTimeout(r,10));}throw new Error('expected physical lock wait: '+needle);
}
export function latch(){let enter,release;const arrived=new Promise(r=>enter=r),hold=new Promise(r=>release=r);return{arrived,hold,enter,release};}
