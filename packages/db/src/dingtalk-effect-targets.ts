import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import type { DingTalkEffectDestination } from "./dingtalk-effect-authority.js";
import type { DingTalkInboundJob } from "./dingtalk-inbound-values.js";
import { dingtalkDenied } from "./dingtalk-company-values.js";
import { storedObject } from "./stored-values.js";

/** Bounded candidate discovery only. No label returned here authorizes an effect. */
export async function dingtalkEffectTargets(tx: DatabaseTransaction,job: DingTalkInboundJob,sourceRef: string,
  kind: "channel" | "automation"): Promise<DingTalkEffectDestination[]> {
  if (!["channel","automation"].includes(kind)) dingtalkDenied();
  const rows=await tx.query<QueryResultRow>({ name: kind==='channel' ? 'dingtalk_effect_channel_candidates_v1' : 'dingtalk_effect_automation_candidates_v1',
    text: kind==='channel' ? `SELECT r.channel_id AS id,r.channel_id,r.created_by AS root,r.version,r.relation_id,
      (extract(epoch from r.created_at)*1000000)::bigint::text AS birth
      FROM data.app_source_relations r JOIN data.channels c ON c.channel_id=r.channel_id AND c.space_id=r.space_id
      WHERE r.connection_id=$1 AND r.space_id=$2 AND r.source_kind='repository' AND lower(r.source_ref)=$3
        AND (r.features_json ? 'all' OR r.features_json ? 'message.received') ORDER BY r.relation_id LIMIT 201`
      : `SELECT a.automation_id AS id,a.channel_id,a.owner_user_id,a.payload_json,a.version,
        (extract(epoch from a.created_at)*1000000)::bigint::text AS birth
        FROM data.automations a JOIN data.channels c ON c.channel_id=a.channel_id
        WHERE c.space_id=$2 AND a.enabled AND a.page_id IS NOT NULL AND
          EXISTS (SELECT 1 FROM jsonb_array_elements(a.payload_json->'triggers') t
            WHERE t->>'kind'='event' AND t->>'provider'='dingtalk'
              AND (t->>'source'='*' OR t->>'source'=substring($3::text from 10))
              AND (NOT t ? 'feature' OR t->>'feature'='message.received')) AND $1::text IS NOT NULL ORDER BY a.automation_id LIMIT 201`,
    values: [job.connectionId,job.spaceId,sourceRef],maxRows: 201 });
  if (rows.length>200) dingtalkDenied();
  return rows.map(row => {
    const root=storedObject(storedObject(storedObject(row.payload_json).input).envRef).authorityRootUserId;
    return { kind,id: String(row.id),channelId: String(row.channel_id),version: Number(row.version),birth: String(row.birth),
      authorityRootUserId: kind==='channel' ? String(row.root) : typeof root==='string' && root ? root : String(row.owner_user_id),
      ...(kind==='channel' ? { relationId: String(row.relation_id) } : { ownerUserId: String(row.owner_user_id) }) };
  });
}
