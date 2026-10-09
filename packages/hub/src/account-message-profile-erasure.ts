import type { AccountMessageProfileRow, PreparedPostgresMessageRecord } from "@xmatrix/db";
import { erasedAccountMessageSender } from "@xmatrix/db";
import { base64UrlDecodeBytes, base64UrlEncodeBytes } from "./relay-v2-primitives";
import { decodeRelayV2MessagePayloadBundle, prepareRelayV2MessageRecord, relayV2StoredOptionalTimestamps } from "./relay-v2-message-record";
import { compactMessageBodyPreview } from "./message-body-preview";

const iso=(value: Date|string)=>new Date(value).toISOString();

/** Erases presentation only. Bodies, residuals, attachments and other authors stay intact. */
export async function prepareErasedAccountMessageProfile(row: AccountMessageProfileRow,userId:string):Promise<PreparedPostgresMessageRecord|null> {
  if(!row.payload_bundle_base64) return null;
  if(!row.field_presence_base64) throw new Error("Message profile erasure requires canonical presence");
  const bundle=decodeRelayV2MessagePayloadBundle(base64UrlDecodeBytes(row.payload_bundle_base64));
  const senderSnapshot=erasedAccountMessageSender(bundle.senderSnapshot,row.author_kind,row.author_id,userId);
  const prepared=await prepareRelayV2MessageRecord({messageId:row.message_id,channelId:row.channel_id,
    timelineSequence:Number(row.timeline_sequence),senderKind:row.author_kind,senderId:row.author_id,messageKind:row.message_kind,
    payloadSchemaVersion:row.payload_schema_version??1,entityVersion:Number(row.entity_version)+1,sentAt:iso(row.sent_at),
    ...relayV2StoredOptionalTimestamps(base64UrlDecodeBytes(row.field_presence_base64),{
      editedAt:row.edited_at?iso(row.edited_at):null,recalledAt:row.recalled_at?iso(row.recalled_at):null,deletedAt:row.deleted_at?iso(row.deleted_at):null}),
    body:bundle.body,senderSnapshot,
    ...(Object.hasOwn(bundle,"residual")?{residual:bundle.residual}:{}),});
  if(prepared.bodyHash!==row.body_hash) throw new Error("Message body integrity mismatch during profile erasure");
  return {codecId:prepared.codecId,payloadSchemaVersion:prepared.payloadSchemaVersion,
    fieldPresenceBase64:base64UrlEncodeBytes(prepared.fieldPresenceBytes),payloadBundleBase64:base64UrlEncodeBytes(prepared.payloadBundleBytes),
    bodyHash:prepared.bodyHash,senderSnapshotDigest:prepared.senderSnapshotDigest,recordDigest:prepared.recordDigest,
    recordEncodedBytes:prepared.recordEncodedBytes,preview:{bodyPreview:compactMessageBodyPreview(bundle.body),senderSnapshot}};
}
