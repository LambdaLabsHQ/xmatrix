import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import type { DingTalkEffectDestination } from "./dingtalk-effect-authority.js";
import type { DingTalkInboundJob } from "./dingtalk-inbound-values.js";
import { dingtalkDenied } from "./dingtalk-company-values.js";

/** Bounded candidate discovery only. No label returned here authorizes an effect. */
export async function dingtalkEffectTargets(tx: DatabaseTransaction,job: DingTalkInboundJob,
  sourceRef: string): Promise<DingTalkEffectDestination[]> {
  const rows=await tx.query<QueryResultRow>({ name: 'dingtalk_effect_channel_candidates_v1',
    text: `SELECT r.channel_id AS id,r.channel_id,r.created_by AS root,r.version,r.relation_id,
      (extract(epoch from r.created_at)*1000000)::bigint::text AS birth
      FROM data.app_source_relations r JOIN data.channels c ON c.channel_id=r.channel_id AND c.space_id=r.space_id
      WHERE r.connection_id=$1 AND r.space_id=$2 AND r.source_kind='repository' AND lower(r.source_ref)=$3
        AND (r.features_json ? 'all' OR r.features_json ? 'message.received') ORDER BY r.relation_id LIMIT 201`,
    values: [job.connectionId,job.spaceId,sourceRef],maxRows: 201 });
  if (rows.length>200) dingtalkDenied();
  return rows.map(row => ({ kind: "channel",id: String(row.id),channelId: String(row.channel_id),version: Number(row.version),
    birth: String(row.birth),authorityRootUserId: String(row.root),relationId: String(row.relation_id) }));
}
