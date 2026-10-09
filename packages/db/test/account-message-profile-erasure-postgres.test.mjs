import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAuthorityDatabase,PostgresAccountDeletionRepository,PostgresSpaceControlRepository} from '../dist/index.js';
import {integration,isolatedPostgres} from './postgres-database.fixture.mjs';
import {prepareRelayV2MessageRecord,decodeRelayV2MessagePayloadBundle} from '../../hub/src/relay-v2-message-record.ts';
import {prepareErasedAccountMessageProfile} from '../../hub/src/account-message-profile-erasure.ts';

async function fixture() {
 const f=await isolatedPostgres('profile_erase',{shard:true});
 const db=createAuthorityDatabase({connectionString:f.url.toString(),shardId:'shard-0'});
 for(const id of ['gone','other']) await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at)
  VALUES($1,$1,$1||'@example.test',true,now(),now())`,[id]);
 await f.run(`INSERT INTO control.auth_sessions(id,token,user_id,expires_at,created_at,updated_at)
  VALUES('fresh','fresh','gone',now()+interval '1 day',now(),now())`);
 await new PostgresSpaceControlRepository(db,'shard-0').createSpace({requestId:randomUUID(),commandId:randomUUID(),spaceId:'shared',ownerUserId:'other',name:'Other members keep this work'});
 const repo=new PostgresAccountDeletionRepository(db,[db],['shard-0'],prepareErasedAccountMessageProfile);
 const proof={userId:'gone',sessionId:'fresh',email:'gone@example.test',requestId:randomUUID(),receiptHash:'f'.repeat(64)};
 return {...f,db,repo,proof};
}

async function message(f,id,sequence,kind='user',owner='gone') {
 const sender=kind==='user'?{userId:owner,label:'Private '+owner,email:owner+'@example.test',avatarUrl:'/personal.png',bio:'private bio'}:
  {kind:'agent',userId:owner,email:owner+'@example.test',agentName:'codex',label:'codex:4',model:'configured-model',instanceId:id};
 const input={messageId:id,channelId:'channel',timelineSequence:sequence,senderKind:kind,senderId:kind==='user'?owner:id,
  messageKind:'text',payloadSchemaVersion:1,entityVersion:1,sentAt:'2026-10-09T00:00:00.000Z',editedAt:null,
  body:'Shared text '+id+' 🎉',senderSnapshot:sender,residual:{replyToMessageId:'original'}};
 const p=await prepareRelayV2MessageRecord(input);
 await f.run(`INSERT INTO data.messages(space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,message_kind,
  content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,codec_id,payload_schema_version,
  field_presence_base64,payload_bundle_base64,body_hash,sender_snapshot_digest,record_digest,record_encoded_bytes,created_at,preview_json,invocation_input_version)
  VALUES('shared','channel',$1,$2,1,$3,$4,'text',$5,'hot-inline',$1,$6,$6,$7,$8,1,$9,$10,$5,$11,$12,$13,$6,$14::jsonb,1)`,
  [id,sequence,kind,input.senderId,p.bodyHash,input.sentAt,'rank:'+id,p.codecId,Buffer.from(p.fieldPresenceBytes).toString('base64url'),
   Buffer.from(p.payloadBundleBytes).toString('base64url'),p.senderSnapshotDigest,p.recordDigest,p.recordEncodedBytes,
   JSON.stringify({bodyPreview:input.body,senderSnapshot:sender})]);
 const receipt={messageId:id,channelId:'channel',sequence,entityVersion:1,senderSnapshot:sender,recordDigest:p.recordDigest,
  replyOrigin:{channelId:'origin',replier:sender}};
 await f.run(`INSERT INTO data.idempotency_keys(space_id,idempotency_key,command_kind,request_digest,result_json,created_at,expires_at)
  VALUES('shared',$1,'message-append',$2,$3::jsonb,now(),now()+interval '1 day')`,[id,'a'.repeat(64),JSON.stringify(receipt)]);
 await f.run(`INSERT INTO data.outbox(outbox_id,space_id,topic,aggregate_kind,aggregate_id,aggregate_sequence,payload_json,status,
  attempts,available_at,created_at,updated_at) VALUES($1,'shared','message','message',$2,$3,$4::jsonb,'pending',0,now(),now(),now())`,
  ['message:shared:'+id+':1',id,sequence,JSON.stringify(receipt)]);
 return {input,p,sender};
}

integration('account deletion erases canonical Human and Agent-owner profiles plus replay copies while shared bodies and other authors remain exact',async()=>{
 const f=await fixture();try {
  const before=[];
  for(let i=1;i<=9;i++) before.push(await message(f,'own-'+i,i,i===9?'agent':'user'));
  const other=await message(f,'other-message',10,'user','other');
  await f.repo.begin(f.proof);await f.repo.advance('gone',async()=>true);
  assert.deepEqual(await f.repo.status(f.proof.requestId,f.proof.receiptHash),{state:'committed'});
  await f.repo.advance('gone',async()=>true);
  assert.deepEqual(await f.repo.status(f.proof.requestId,f.proof.receiptHash),{state:'completed'});
  const rows=await f.run(`SELECT message_id,payload_bundle_base64,body_hash,sender_snapshot_digest,record_digest,
   field_presence_base64,entity_version,preview_json,invocation_input_version FROM data.messages ORDER BY timeline_sequence`);
  for(let i=0;i<9;i++) {
   const row=rows[i],bundle=decodeRelayV2MessagePayloadBundle(Buffer.from(row.payload_bundle_base64,'base64url'));
   assert.equal(bundle.body,before[i].input.body);
   assert.deepEqual(bundle.residual,before[i].input.residual);
   assert.equal(row.body_hash,before[i].p.bodyHash);
   assert.equal(row.field_presence_base64,Buffer.from(before[i].p.fieldPresenceBytes).toString('base64url'));
   assert.equal(Number(row.entity_version),2);assert.equal(Number(row.invocation_input_version),1);
   assert.equal(bundle.senderSnapshot.email,i===8?undefined:'');
   if(i===8) assert.equal(bundle.senderSnapshot.agentName,'codex');
   else assert.equal(bundle.senderSnapshot.label,'Deleted account');
   assert.equal(JSON.stringify(bundle.senderSnapshot).includes('Private gone'),false);
   assert.equal(row.preview_json.senderSnapshot.email,i===8?undefined:'');
   const regenerated=await prepareRelayV2MessageRecord({...before[i].input,entityVersion:2,senderSnapshot:bundle.senderSnapshot});
   assert.equal(row.record_digest,regenerated.recordDigest);assert.equal(row.sender_snapshot_digest,regenerated.senderSnapshotDigest);
  }
  assert.equal(rows[9].payload_bundle_base64,Buffer.from(other.p.payloadBundleBytes).toString('base64url'));
  for(const [table,column] of [['idempotency_keys','result_json'],['outbox','payload_json']]) {
   const copies=await f.run(`SELECT ${column} AS copy FROM data.${table} WHERE ${column}->>'messageId' LIKE 'own-%'`);
   assert.ok(copies.length>=9);
   for(const {copy} of copies) {assert.equal(copy.senderSnapshot,undefined);assert.equal(copy.replyOrigin?.replier,undefined);}
  }
  await assert.rejects(message(f,'late',11),/closing or deleted/);
  await assert.rejects(message(f,'late-agent',12,'agent'),/closing or deleted/);
  assert.equal((await f.run(`SELECT historical_profile_cleanup_done FROM control.account_deletion_requests WHERE user_id='gone'`))[0].historical_profile_cleanup_done,true);
 }finally {await f.close();}
});

integration('bounded replay-copy cleanup resumes before marking the canonical message erased',async()=>{
 const f=await fixture();try {
  const original=await message(f,'own',1);
  await f.run(`INSERT INTO data.idempotency_keys(space_id,idempotency_key,command_kind,request_digest,result_json,created_at,expires_at)
   SELECT 'shared','historical-'||n,'message-append',$1,jsonb_build_object('messageId','own','senderSnapshot',$2::jsonb),now(),now()+interval '1 day'
   FROM generate_series(1,500) n`,['b'.repeat(64),JSON.stringify(original.sender)]);
  await f.repo.begin(f.proof);await f.repo.advance('gone',async()=>true);
  assert.deepEqual(await f.repo.status(f.proof.requestId,f.proof.receiptHash),{state:'committed'});
  assert.equal((await f.run(`SELECT sender_profile_erased_at FROM data.messages WHERE message_id='own'`))[0].sender_profile_erased_at,null);
  assert.equal((await f.run(`SELECT count(*)::int n FROM data.idempotency_keys WHERE result_json ? 'senderSnapshot'`))[0].n,1);
  await f.repo.advance('gone',async()=>true);
  assert.deepEqual(await f.repo.status(f.proof.requestId,f.proof.receiptHash),{state:'completed'});
  assert.equal((await f.run(`SELECT count(*)::int n FROM data.idempotency_keys WHERE result_json ? 'senderSnapshot'`))[0].n,0);
 }finally {await f.close();}
});

integration('a corrupt payload leaves committed deletion retryable and never erases another author',async()=>{
 const f=await fixture();try {
  await message(f,'own',1);const other=await message(f,'untouched',2,'user','other');
  await f.run(`UPDATE data.messages SET payload_bundle_base64='AA' WHERE message_id='own'`);
  await f.repo.begin(f.proof);
  await f.run(`INSERT INTO control.auth_sessions(id,token,user_id,expires_at,created_at,updated_at)
   VALUES('other-fresh','other-fresh','other',now()+interval '1 day',now(),now())`);
  await f.repo.begin({...f.proof,userId:'other',sessionId:'other-fresh',email:'other@example.test',requestId:randomUUID(),receiptHash:'e'.repeat(64)});
  await assert.rejects(f.repo.advance('gone',async()=>true));
  assert.deepEqual(await f.repo.status(f.proof.requestId,f.proof.receiptHash),{state:'committed'});
  assert.equal(await f.repo.revoked('gone'),true);
  assert.equal((await f.run(`SELECT sender_profile_erased_at FROM data.messages WHERE message_id='own'`))[0].sender_profile_erased_at,null);
  assert.equal((await f.run(`SELECT payload_bundle_base64 FROM data.messages WHERE message_id='untouched'`))[0].payload_bundle_base64,
   Buffer.from(other.p.payloadBundleBytes).toString('base64url'));
  assert.deepEqual(await f.repo.pending(),['other','gone'],'a corrupt historical job must not starve later deletion requests');
 }finally {await f.close();}
});

integration('completed pre-upgrade deletions receive historical cleanup without reviving credentials',async()=>{
 const f=await fixture();try {
  await message(f,'historical',1);
  await f.run(`INSERT INTO data.account_deletion_fences(user_id,request_id,committed,cleaned) VALUES('gone',$1,true,true)`,[f.proof.requestId]);
  await f.run(`DELETE FROM control.auth_users WHERE id='gone'`);
  await f.run(`INSERT INTO control.account_deletion_requests(user_id,request_id,state,receipt_hash,committed_at,completed_at,avatar_cleanup_done)
   VALUES('gone',$1,'completed',$2,now()-interval '2 days',now()-interval '2 days',true)`,[f.proof.requestId,f.proof.receiptHash]);
  assert.deepEqual(await f.repo.pending(),['gone']);
  await f.repo.advance('gone',async()=>true);
  const row=(await f.run(`SELECT preview_json FROM data.messages WHERE message_id='historical'`))[0];
  assert.equal(row.preview_json.senderSnapshot.label,'Deleted account');
  assert.deepEqual(await f.repo.status(f.proof.requestId,f.proof.receiptHash),{state:'completed'});
  assert.deepEqual(await f.repo.pending(),[]);
  assert.equal((await f.run(`SELECT count(*)::int n FROM control.auth_users WHERE id='gone'`))[0].n,0);
 }finally {await f.close();}
});
