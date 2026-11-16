import { digestCanonicalCloneCborV1 } from '@xmatrix/protocol';
import { createAuthorityDatabase, PostgresDingTalkInboundInboxRepository, PostgresMessageRepository } from '../dist/index.js';
import { inboundFixture } from './dingtalk-inbound.fixture.mjs';
import { connectionString } from './postgres-database.fixture.mjs';

/** Full migrated schema, implementation fixtures only; no native conversation proof. */
export async function effectFixture(run, constructors={}) {
  return inboundFixture(async f => {
    const spaceId=f.spaces[0],channelId=spaceId+':channel',relationId=spaceId+':relation';
    f.applicationName='dt-effects:'+spaceId;
    f.database=createAuthorityDatabase({connectionString,shardId:'shard-0',applicationName:f.applicationName,statementTimeoutMs:5000,transactionTimeoutMs:10000,lockTimeoutMs:2000});
    f.inbox=new (constructors.PostgresDingTalkInboundInboxRepository??PostgresDingTalkInboundInboxRepository)(f.database,f.key);
    await f.sql(`INSERT INTO data.spaces(space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES($1,'owner','Effect test',$1,1,'{}',now(),now())`,[spaceId]);
    await f.sql(`INSERT INTO data.space_control_heads(space_id,commit_sequence,updated_at) VALUES($1,0,now())`,[spaceId]);
    await f.sql(`INSERT INTO control.space_placement(space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
      VALUES($1,'shard-0',1,'active','test',now(),now())`,[spaceId]);
    await f.sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES($1,'target','member',1,now(),now())`,[spaceId]);
    await f.sql(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES($1,$2,'Effect test',$1,'closed',$1,1,'{}',now(),now())`,[channelId,spaceId]);
    await f.sql(`INSERT INTO data.channel_access(space_id,channel_id,subject_kind,subject_id,grant_version,created_at,updated_at)
      VALUES($1,$2,'user','target',1,now(),now())`,[spaceId,channelId]);
    await f.inbound();await f.accept(await f.message());const [job]=await f.inbox.claim(f.request());
    const source=await f.current(job);
    await f.sql(`INSERT INTO data.app_source_relations(relation_id,connection_id,space_id,channel_id,source_kind,source_ref,
      features_json,version,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,'repository',$5,'["message.received"]',1,'target',now(),now())`,
    [relationId,job.connectionId,spaceId,channelId,source.sourceRef]);
    const destination=async () => {
      const row=(await f.sql(`SELECT version,(extract(epoch from created_at)*1000000)::bigint::text birth FROM data.app_source_relations WHERE relation_id=$1`,[relationId])).rows[0];
      return { kind: 'channel',id: channelId,channelId,authorityRootUserId: 'target',version: Number(row.version),birth: row.birth,relationId };
    };
    const cap=async (kind='channel',signal=new AbortController().signal,extra={}) => f.inbox.effectAuthority(f.request({ job,destination: await destination(),signal,...extra }));
    const messages=new PostgresMessageRepository(f.database);
    const appendInput=async authority => {
      const reservation=await messages.reserveAppendSequence({ requestId: crypto.randomUUID(),commandId: authority.effectId,
        spaceId,channelId,observedPostgresHead: 0 });
      return { requestId: crypto.randomUUID(),commandId: authority.effectId,messageId: authority.effectId,spaceId,channelId,sequence: reservation.sequence,
        principal: { kind: 'user',id: 'target' },senderKind: 'app',senderId: 'dingtalk',messageKind: 'xmatrix.message.text',sentAt: await f.time(),
        requestDigest: '1'.repeat(64),senderSnapshot: { kind: 'app',id: 'dingtalk' },attentionBody: source.candidate.text,
        // Trusted prepared-record contract fixture; this exercises the actual owning transaction, not the Hub codec or native API.
        prepared: { codecId: 'canonical-clone-cbor-v1',payloadSchemaVersion: 1,fieldPresenceBase64: 'AA',payloadBundleBase64: 'AA',
          bodyHash: await digestCanonicalCloneCborV1(source.candidate.text),senderSnapshotDigest: '3'.repeat(64),recordDigest: '4'.repeat(64),recordEncodedBytes: 10,
          preview: { bodyPreview: source.candidate.text,senderSnapshot: { kind: 'app',id: 'dingtalk' } } } };
    };
    try { await run({ ...f,spaceId,channelId,relationId,job,source,cap,destination,messages,appendInput }); }
    finally {
      for (const table of ['app_source_relations','message_sequence_reservations','message_mutations','message_attention','message_attention_revisions','messages','idempotency_keys','outbox','channel_content_counters','channel_message_sequences','channel_access','space_control_heads','channels']) {
        await f.sql(`DELETE FROM data.${table} WHERE space_id=$1`,[spaceId]);
      }
      await f.sql("DELETE FROM control.scoped_control_command_replays WHERE scope_kind='space' AND scope_id=$1",[spaceId]);
      await f.sql('DELETE FROM control.space_placement WHERE space_id=$1',[spaceId]);
      await f.sql('DELETE FROM data.spaces WHERE space_id=$1',[spaceId]);
      await f.database.close?.();
    }
  });
}

/** Pause after an actual query has executed, holding its real locks. */
export function pauseQuery(database,name,after=()=>{},matches=()=>true) {
  let arrived,release;const waiting=new Promise(r=>arrived=r),resume=new Promise(r=>release=r);
  const observed=target=>({ ...target,openSession:()=>observed(target.openSession()),close:()=>target.close?.(),
    transaction: (context,run)=>target.transaction(context,tx=>run({ ...tx,query: async q => {
    const rows=await tx.query(q);if(q.name===name && matches(q)){await after(q);arrived();await resume;}return rows;
  } })) });
  return { waiting,release,database:observed(database) };
}
