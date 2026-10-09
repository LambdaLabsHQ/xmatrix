import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { QueryResultRow } from "pg";
import type { PreparedPostgresMessageRecord } from "./message-control.js";
import { PostgresSpacePlacementDirectory } from "./placement.js";
import { storedMessagePreview } from "./message-preview.js";
import { writeOutbox } from "./outbox.js";
import { normalizeMessageCreateEvent } from "./message-control.js";

export interface AccountMessageProfileRow extends QueryResultRow {
  space_id: string; channel_id: string; message_id: string; author_kind: string; author_id: string;
  timeline_sequence: number | string; entity_version: number | string; message_kind: string;
  payload_schema_version: number | null; payload_bundle_base64: string | null;
  field_presence_base64: string | null; body_hash: string | null;
  sent_at: Date | string; edited_at: Date | string | null; recalled_at: Date | string | null;
  deleted_at: Date | string | null; preview_json: { bodyPreview: string; senderSnapshot: Record<string, unknown> } | null;
}
/** The Hub's existing message codec prepares bytes; SQL remains the fact owner. */
export type PrepareErasedMessageProfile = (row: AccountMessageProfileRow, userId: string) =>
  Promise<PreparedPostgresMessageRecord | null>;

const BATCH = 8;

/** Shared by canonical payload and legacy previews; no caller controls the account scope. */
export function erasedAccountMessageSender(snapshot: Record<string,unknown>|null,kind:string,authorId:string,userId:string):Record<string,unknown> {
  if(kind==='user') {
    if(authorId!==userId) throw new Error("Message profile owner does not match deleted identity");
    return {identityId:`user:${userId}`,kind:"user",userId,label:"Deleted account",email:""};
  }
  if(kind!=='agent'||(snapshot && snapshot.userId!==userId)) throw new Error("Message profile owner does not match deleted identity");
  if(!snapshot) return {identityId:authorId,kind:"agent",userId,label:"Unknown agent",email:""};
  const fields=new Set(["identityId","kind","agentId","label","name","agentName","runtime","userId","registration",
    "instanceId","channelInstanceId","instanceLabel","originChannelId","originMessageId","avatarUrl","profileVersion",
    "goal","gitBranch","model","effort","statusChips"]);
  return Object.fromEntries(Object.entries(snapshot).filter(([key])=>fields.has(key)));
}

async function assertCommitted(tx: DatabaseTransaction, userId: string): Promise<void> {
  await tx.query({name:"account_message_erasure_lock_v1",text:"SELECT pg_advisory_xact_lock(hashtextextended('account-deletion:'||$1,0))",values:[userId],maxRows:1});
  const fence=await tx.query({name:"account_message_erasure_fence_v1",text:"SELECT user_id FROM data.account_deletion_fences WHERE user_id=$1 AND committed",values:[userId],maxRows:1});
  if(!fence.length) throw new Error("Message profile erasure requires committed account deletion");
}

/** Eight records/pass, with the directory's placement and each canonical row locked. */
export async function eraseAccountMessageProfiles(directory: AuthorityDatabase, shard: AuthorityDatabase,
  shardId: string, userId: string, prepare?: PrepareErasedMessageProfile): Promise<boolean> {
  const candidates=await shard.transaction({requestId:crypto.randomUUID(),operation:"account-deletion.message-candidates"},async tx=>{
    await assertCommitted(tx,userId);
    return tx.query<{space_id:string;message_id:string}>({name:"account_message_profile_candidates_v1",text:`SELECT space_id,message_id FROM (
      (SELECT space_id,message_id FROM data.messages WHERE author_kind='user' AND author_id=$1
        AND sender_profile_erased_at IS NULL ORDER BY space_id,message_id LIMIT 8)
      UNION
      (SELECT space_id,message_id FROM data.messages WHERE author_kind='agent'
        AND preview_json#>>'{senderSnapshot,userId}'=$1 AND sender_profile_erased_at IS NULL
        ORDER BY space_id,message_id LIMIT 8)
      UNION
      (SELECT m.space_id,m.message_id FROM data.messages m JOIN data.instances i ON i.instance_id=m.author_id
        JOIN data.run_agent_registrations r ON r.run_id=i.run_id AND r.space_id=m.space_id
        WHERE m.author_kind='agent' AND m.preview_json IS NULL AND r.owner_user_id=$1
          AND m.sender_profile_erased_at IS NULL ORDER BY m.space_id,m.message_id LIMIT 8)
      ) candidates ORDER BY space_id,message_id LIMIT 8`,values:[userId],maxRows:BATCH});
  });
  const placements=new PostgresSpacePlacementDirectory(directory);
  let copyBudget=500;
  for(const candidate of candidates) {
    const placement=await placements.resolveWritable({requestId:crypto.randomUUID(),operation:"account-deletion.message-placement"},candidate.space_id,
      ()=>new Error("Message erasure waits for writable Space placement"));
    if(placement.shardId!==shardId) return false;
    const erased=await shard.transaction({requestId:crypto.randomUUID(),operation:"account-deletion.message-profile",placement},async tx=>{
      await assertCommitted(tx,userId);
      const rows=await tx.query<AccountMessageProfileRow>({name:"account_message_profile_read_v1",text:`SELECT space_id,channel_id,message_id,
        author_kind,author_id,timeline_sequence,entity_version,message_kind,payload_schema_version,payload_bundle_base64,field_presence_base64,body_hash,
        sent_at,edited_at,recalled_at,deleted_at,preview_json FROM data.messages
        WHERE space_id=$1 AND message_id=$2 AND sender_profile_erased_at IS NULL FOR UPDATE`,values:[candidate.space_id,candidate.message_id],maxRows:1});
      const row=rows[0]; if(!row) return true;
      if(!prepare) throw new Error("Message profile erasure codec is unavailable");
      const prepared=await prepare(row,userId);
      const now=new Date().toISOString(), version=Number(row.entity_version)+1;
      const sender=prepared?.preview.senderSnapshot??erasedAccountMessageSender(row.preview_json?.senderSnapshot??null,row.author_kind,row.author_id,userId);
      for(const [table,column] of [["data.idempotency_keys","result_json"],["data.outbox","payload_json"]] as const) {
        if(copyBudget===0) return false;
        const copies=await tx.query<{count:number}>({name:`account_message_profile_${column}_v2`,text:`WITH scrubbed AS (
          UPDATE ${table} SET ${column}=((${column}-'senderSnapshot')#-'{replyOrigin,replier}')||jsonb_build_object('senderProfileErased',true)
          WHERE ctid IN (SELECT ctid FROM ${table} WHERE space_id=$1 AND ${column}->>'messageId'=$2
            AND ${column} ? 'senderSnapshot' AND ${column==='result_json'?"command_kind LIKE 'message%'":"topic='message' AND aggregate_kind='message'"}
            LIMIT $3) RETURNING 1)
          SELECT count(*)::int AS count FROM scrubbed`,values:[row.space_id,row.message_id,copyBudget],maxRows:1});
        copyBudget-=Number(copies[0]?.count??0);
        if(copyBudget===0) return false;
      }
      await tx.query({name:"account_message_profile_rewrite_v1",text:`UPDATE data.messages SET
        sender_profile_erased_at=$3,entity_version=$4,updated_at=$3,
        field_presence_base64=COALESCE($5,field_presence_base64),payload_bundle_base64=COALESCE($6,payload_bundle_base64),
        sender_snapshot_digest=COALESCE($7,sender_snapshot_digest),record_digest=COALESCE($8,record_digest),
        record_encoded_bytes=COALESCE($9,record_encoded_bytes),preview_json=$10::jsonb
        WHERE space_id=$1 AND message_id=$2`,values:[row.space_id,row.message_id,now,version,
          prepared?.fieldPresenceBase64??null,prepared?.payloadBundleBase64??null,prepared?.senderSnapshotDigest??null,
          prepared?.recordDigest??null,prepared?.recordEncodedBytes??null,
          prepared?storedMessagePreview(prepared.preview):row.preview_json?storedMessagePreview({...row.preview_json,senderSnapshot:sender}):null],maxRows:0});
      await tx.query({name:"account_message_profile_revision_v1",text:`INSERT INTO data.channel_content_counters(space_id,channel_id,content_revision,updated_at)
        VALUES($1,$2,1,$3) ON CONFLICT(space_id,channel_id) DO UPDATE SET content_revision=data.channel_content_counters.content_revision+1,updated_at=EXCLUDED.updated_at`,values:[row.space_id,row.channel_id,now],maxRows:0});
      await normalizeMessageCreateEvent(tx,{spaceId:row.space_id,channelId:row.channel_id,messageId:row.message_id});
      await tx.query({name:"account_message_profile_ledger_v1",text:`INSERT INTO data.message_mutations(space_id,channel_id,message_id,entity_version,
        mutation_kind,mutation_json,actor_kind,actor_id,occurred_at) VALUES($1,$2,$3,$4,'edit','{"senderProfileErased":true}','system','xmatrix',$5)`,
        values:[row.space_id,row.channel_id,row.message_id,version,now],maxRows:0});
      await writeOutbox(tx,{name:"account_message_profile_event_v1",outboxId:`message:${row.space_id}:${row.message_id}:${version}`,
        spaceId:row.space_id,topic:"message",aggregateKind:"message",aggregateId:row.message_id,aggregateSequence:version,
        payload:{messageId:row.message_id,channelId:row.channel_id,entityVersion:version,senderProfileErased:true},at:now});
      return true;
    });
    if(!erased) return false;
  }
  return candidates.length<BATCH;
}
