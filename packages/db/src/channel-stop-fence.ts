import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import { commitRuntime, expireInstanceTraceAccess } from "./runtime-control.js";
import { parseAgentStopCommand } from "@xmatrix/protocol";
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
  return fenced.length;
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
