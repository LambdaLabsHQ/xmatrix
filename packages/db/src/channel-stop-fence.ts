import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import { commitRuntime, expireInstanceTraceAccess } from "./runtime-control.js";
import { CHANNEL_ACTIVITY_MESSAGE_KIND, parseAgentStopCommand } from "@xmatrix/protocol";
import { resolveMessageAgentTargets } from "./message-agent-targets.js";

/** Bounded like every Runtime scan; a repeated `/kill all` fences the rest. */
const CHANNEL_STOP_FENCE_LIMIT = 200;

/** What a stop command addresses: every live Run, or one exact Run. */
export type ChannelStopScope = { kind: "channel" } | { kind: "run"; runId: string };

/**
 * Stop fence. Runs inside the Human's message append transaction, so the stop
 * and the message commit together: once the message is visible, no Run it
 * addresses may append another message, take delivery, start from a pending
 * launch, or keep a one-shot trace grant. Host process termination is
 * delivered afterwards, and only its confirmation moves the Run from
 * `stopping` to `stopped`.
 *
 * A Human without `runtime_terminalize` fences nothing; the message still
 * commits and the Hub reports the refusal as before.
 */
export async function fenceChannelRunsForStop(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; actorUserId: string; sourceMessageId: string; at: string;
  scope: ChannelStopScope;
}): Promise<number> {
  const stopRequest = { sourceMessageId: input.sourceMessageId, actorUserId: input.actorUserId,
    requestedAt: input.at };
  const fenced = await tx.query<QueryResultRow>({ name: "channel_stop_fence_v3", text: `WITH authorized AS (
      SELECT c.channel_id FROM data.channels c WHERE c.space_id=$1 AND c.channel_id=$2
        AND ${channelCapabilityPredicate({ capability: "runtime_terminalize", channelAlias: "c",
          principalKindSql: "'user'", principalIdSql: "$3::text" })}
    ), target AS (
      SELECT r.run_id FROM data.runs r JOIN authorized a ON a.channel_id=r.channel_id
      WHERE r.status IN ('starting','running')
        AND COALESCE(r.metadata_json->>'routedAs','')<>'management_channel_about'
        AND ($5::text IS NULL OR r.run_id=$5)
      ORDER BY r.run_id LIMIT ${CHANNEL_STOP_FENCE_LIMIT} FOR UPDATE OF r
    ), cancelled AS (
      UPDATE data.agent_launches l SET state='cancelled',retryable=FALSE,lease_owner=NULL,lease_until=NULL,
        version=l.version+1,updated_at=clock_timestamp(),finished_at=clock_timestamp()
      FROM target WHERE l.run_id=target.run_id AND l.state IN ('prepared','queued','admitted','spawned')
      RETURNING l.run_id
    ) UPDATE data.runs r SET status='stopping',version=r.version+1,updated_at=clock_timestamp(),
      metadata_json=COALESCE(r.metadata_json,'{}'::jsonb) || jsonb_build_object('stopRequest',$4::jsonb)
    FROM target WHERE r.run_id=target.run_id
    RETURNING r.run_id,r.version,(SELECT i.instance_id FROM data.instances i WHERE i.run_id=r.run_id) AS instance_id`,
  values: [input.spaceId, input.channelId, input.actorUserId, JSON.stringify(stopRequest),
    input.scope.kind === "run" ? input.scope.runId : null],
  maxRows: CHANNEL_STOP_FENCE_LIMIT });
  for (const row of fenced) {
    await commitRuntime(tx, input.spaceId, { commandId: `channel-stop:${input.sourceMessageId}:${row.run_id}`
      .slice(0, 200), kind: "run_transition", entityId: row.run_id, entityVersion: Number(row.version),
    status: "stopping", reason: "channel_stop" }, input.at);
    await expireInstanceTraceAccess(tx, row.instance_id, input.at);
  }
  // A stopped Run waits on nobody.
  const stopped = fenced.flatMap((row) => typeof row.instance_id === "string" ? [row.instance_id] : []);
  if (stopped.length > 0) await releaseDeclaredWaits(tx, { spaceId: input.spaceId, channelId: input.channelId,
    authorKind: "agent", authorIds: stopped, at: input.at });
  return fenced.length;
}

/**
 * Releases the waits an author declared in a conversation (`awaiting_response`
 * on the mentions of its messages): all of them, or with `movedOnAt` only
 * those someone else has spoken after, before that sequence: the author went
 * on with another's answer, so its targets no longer hold it up.
 */
export async function releaseDeclaredWaits(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; authorKind: "user" | "agent"; authorIds: string[]; at: string;
  movedOnAt?: number;
}): Promise<void> {
  await tx.query({ name: "message_attention_release_waits_v1", text: `WITH released AS (
      UPDATE data.message_attention a SET awaiting_response=FALSE
      FROM data.messages m
      WHERE a.space_id=$1 AND a.channel_id=$2 AND a.awaiting_response
        AND m.space_id=a.space_id AND m.channel_id=a.channel_id AND m.message_id=a.message_id
        AND m.author_kind=$3 AND m.author_id=ANY($4::text[])
        AND ($5::bigint IS NULL OR EXISTS (SELECT 1 FROM data.messages other
          WHERE other.space_id=a.space_id AND other.channel_id=a.channel_id
            AND other.timeline_sequence>a.timeline_sequence AND other.timeline_sequence<$5
            AND other.deleted_at IS NULL AND other.author_kind IN ('user','agent')
            AND NOT (other.author_kind=$3 AND other.author_id=ANY($4::text[]))
            AND other.message_kind<>'${CHANNEL_ACTIVITY_MESSAGE_KIND}'))
      RETURNING a.subject_id
    ) INSERT INTO data.message_attention_revisions (space_id,subject_id,channel_id,revision,updated_at)
    SELECT DISTINCT $1,released.subject_id,$2,1,$6::timestamptz FROM released
    ON CONFLICT (space_id,subject_id,channel_id) DO UPDATE SET
      revision=data.message_attention_revisions.revision+1,updated_at=EXCLUDED.updated_at`,
  values: [input.spaceId, input.channelId, input.authorKind, input.authorIds, input.movedOnAt ?? null, input.at],
  maxRows: 0 });
}

/** The Runs a stop message addresses, resolved with the same exact-address
 * resolver as the message's own targets. An ambiguous or unknown address
 * fences nothing; the Hub reports it. */
export async function channelStopScope(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; messageId: string; body: string;
}): Promise<ChannelStopScope | undefined> {
  const command = parseAgentStopCommand(input.body);
  if (!command) return undefined;
  if (command.all) return { kind: "channel" };
  if (!/:[1-9]\d*$/u.test(command.target)) return undefined;
  const [target] = await resolveMessageAgentTargets(tx, { spaceId: input.spaceId, channelId: input.channelId,
    messageId: input.messageId, body: `@${command.target}` }) ?? [];
  return target?.resolution === "resolved" && target.runId ? { kind: "run", runId: target.runId } : undefined;
}
