import { digestCanonicalCloneCborV1, sha256Hex } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import type { DingTalkInboundJob } from "./dingtalk-inbound-values.js";
import type { PostgresDingTalkInboundInboxRepository } from "./dingtalk-inbound-inbox.js";
import { dingtalkDenied } from "./dingtalk-company-values.js";
import { dingtalkTransactionPreparation, type DingTalkPreparedPlan } from "./dingtalk-prepared-port.js";
import { lockChannelLifecycle, requireChannelCapability } from "./channel-capability-policy.js";

type Current = NonNullable<Awaited<ReturnType<PostgresDingTalkInboundInboxRepository["current"]>>>;
export type DingTalkEffectDestination = { kind: "channel" | "automation"; id: string; channelId: string;
  authorityRootUserId: string; version: number; birth: string; relationId?: string; ownerUserId?: string };
/** Opaque server-owned capability. JSON metadata can never construct one. */
export interface DingTalkEffectAuthority { readonly effectId: string; readonly spaceId: string; readonly destination: Readonly<DingTalkEffectDestination> }
type Grant = { job: DingTalkInboundJob; destination: DingTalkEffectDestination; primaryShardId: string;
  signal: AbortSignal; source(tx: DatabaseTransaction): Promise<Current | null>; prepared?: DingTalkPreparedPlan };
const completions=new WeakMap<DatabaseTransaction,DingTalkEffectAuthority>();
export function dingtalkPreparedEffectComplete(tx: DatabaseTransaction,authority: DingTalkEffectAuthority) { return completions.get(tx)===authority; }
export function dingtalkEffectId(j: DingTalkInboundJob,d: DingTalkEffectDestination) {
  return sha256Hex(JSON.stringify([j.appIdentity,j.connectionId,j.inboundGeneration,j.eventDigest,
    d.kind==='channel' ? 'append' : 'fire-trigger',d.kind,d.id])).then(digest=>"dingtalk-effect:"+digest);
}
const grants = new WeakMap<DingTalkEffectAuthority,Grant>();

/** Package-internal factory: the primary inbox owner supplies the transaction-scoped source resolver. */
export async function createDingTalkEffectAuthority(grant: Grant): Promise<DingTalkEffectAuthority> {
  const d=grant.destination,j=grant.job;
  if (!d.id || !d.channelId || !d.authorityRootUserId || !Number.isSafeInteger(d.version) || d.version<1 ||
    !d.birth || !["channel","automation"].includes(d.kind) || (d.kind==='channel' && (!d.relationId || d.id!==d.channelId)) ||
    (d.kind==='automation' && !d.ownerUserId) || !grant.primaryShardId || grant.signal.aborted) dingtalkDenied();
  const effectId=await dingtalkEffectId(j,d);
  const authority=Object.freeze({ effectId,spaceId: j.spaceId,destination: Object.freeze({ ...d }) });
  grants.set(authority,{ ...grant,job: { ...j },destination: { ...d } });
  return authority;
}

/** Private coordinator issues this only after an exact source PREPARE vote.
 * The capability is usable exclusively inside its reserved target PREPARE, never
 * an ordinary transaction. Native facts remain pinned at their source owner. */
export async function createDingTalkPreparedEffectAuthority(input: { job: DingTalkInboundJob; destination: DingTalkEffectDestination;
  current: Current; plan: DingTalkPreparedPlan; signal: AbortSignal }) {
  const current=structuredClone(input.current),plan=Object.freeze({ ...input.plan });
  const authority=await createDingTalkEffectAuthority({ job: input.job,destination: input.destination,signal: input.signal,
    primaryShardId: plan.shardId,prepared: plan,source: async tx => {
      if (dingtalkTransactionPreparation(tx)?.gid!==plan.gid) dingtalkDenied();
      const rows=await tx.query({ name: 'dingtalk_prepared_effect_deadline_v1',text: 'SELECT clock_timestamp()<to_timestamp($1::double precision/1000) AS valid',
        values: [current.deadlineEpoch],maxRows: 1 });
      return rows[0]?.valid ? current : null;
    } });
  return authority;
}

/** Source and destination are re-read inside the actual effect owner's transaction, never through an RPC bool. */
export async function authorizeDingTalkEffect(tx: DatabaseTransaction,authority: DingTalkEffectAuthority,input: {
  kind: "channel" | "automation"; id: string; channelId: string; spaceId: string; shardId: string;
  effectId: string; authorityRootUserId: string; bodyHash?: string;
}) {
  const grant=grants.get(authority);
  if (!grant || grant.signal.aborted || input.shardId!==grant.primaryShardId || input.spaceId!==grant.job.spaceId ||
    input.effectId!==authority.effectId || input.kind!==grant.destination.kind || input.id!==grant.destination.id ||
    input.channelId!==grant.destination.channelId || input.authorityRootUserId!==grant.destination.authorityRootUserId) dingtalkDenied();
  const current=await grant.source(tx);
  if (!current || grant.signal.aborted || (input.kind==='channel' && input.bodyHash!==await digestCanonicalCloneCborV1(current.candidate.text))) dingtalkDenied();
  // Member writers take the member row first. Lock before the Channel, and
  // evaluate permission in a new statement after each potentially blocking lock.
  const humans=[...new Set([current.installation.actorUserId,input.authorityRootUserId,
    ...(grant.destination.ownerUserId ? [grant.destination.ownerUserId] : [])])].sort();
  for (const id of humans) {
    const locked=await tx.query({ name: 'dingtalk_effect_member_lock_v1',text: `SELECT 1 FROM data.space_members
      WHERE space_id=$1 AND user_id=$2 FOR SHARE`,values: [input.spaceId,id],maxRows: 1 });
    if (locked.length!==1) dingtalkDenied();
  }
  const capability=input.kind==='channel' ? 'message_append' : 'automation_new_work';
  await lockChannelLifecycle(tx,{ channelId: input.channelId,capability });
  for (const id of humans) {
    const member=await tx.query({ name: 'dingtalk_effect_target_member_v1',text: `SELECT role,version::text || ':' || (extract(epoch from created_at)*1000000)::bigint::text AS generation FROM data.space_members
      WHERE space_id=$1 AND user_id=$2 AND role NOT IN ('viewer','participant')`,values: [input.spaceId,id],maxRows: 1 });
    if (!member.length || (grant.prepared && id===current.installation.actorUserId &&
      (!["owner","admin"].includes(String(member[0]?.role)) || member[0]?.generation!==current.actorMembershipGeneration))) dingtalkDenied();
    await requireChannelCapability(tx,{ spaceId: input.spaceId,channelId: input.channelId,principal: { kind: 'user',id },
      capability,error: () => { dingtalkDenied(); } });
  }
  if (input.kind==='channel') {
    const rows=await tx.query<QueryResultRow>({ name: 'dingtalk_effect_relation_v1',text: `SELECT r.*,
      (extract(epoch from r.created_at)*1000000)::bigint::text AS birth FROM data.app_source_relations r
      WHERE r.relation_id=$1 AND r.space_id=$2 AND r.channel_id=$3 AND r.connection_id=$4 AND r.source_kind='repository'
        AND lower(r.source_ref)=$5 FOR SHARE`,values: [grant.destination.relationId,input.spaceId,input.channelId,
        grant.job.connectionId,current.sourceRef],maxRows: 1 });
    const row=rows[0];
    if (!row || row.created_by!==input.authorityRootUserId || Number(row.version)!==grant.destination.version ||
      row.birth!==grant.destination.birth || !Array.isArray(row.features_json) ||
      (!row.features_json.includes('all') && !row.features_json.includes('message.received'))) dingtalkDenied();
  }
  if (grant.signal.aborted) dingtalkDenied();
  return current;
}

/** The owning transaction holds source/target locks until commit; cancellation and lease time are checked again after writes. */
export async function finishDingTalkEffect(tx: DatabaseTransaction,authority: DingTalkEffectAuthority) {
  const grant=grants.get(authority);
  if (!grant || grant.signal.aborted || !await grant.source(tx) || grant.signal.aborted) dingtalkDenied();
  if (grant.prepared) completions.set(tx,authority);
}
