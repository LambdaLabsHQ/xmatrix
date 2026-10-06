import type { QueryResultRow } from "pg";
import { cleanAgentRuntimeExecution, cleanAgentRuntimeExecutions, sha256Hex, type SerializedAgentMessageExecution , utf8ByteLength } from "@xmatrix/protocol";
import type { DatabaseTransaction } from "./contracts.js";
import { RuntimeControlError } from "./runtime-control.js";

const TERMINAL = new Set(["completed", "failed", "interrupted", "unknown"]);
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function hash(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value));
}

/** The caller must authorize current Channel access in this same transaction. */
export async function queryMessageExecutions(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; messageIds: readonly string[]; limit: number;
  position?: [string, string] | null; runId?: string; viewerUserId?: string;
}): Promise<{ records: SerializedAgentMessageExecution[]; next: [string, string] | null }> {
  if (input.position === null) return { records: [], next: null };
  const rows = await tx.query<QueryResultRow>({ name: "runtime_message_execution_query_v5", text: `SELECT report.*,
      reply.message_id AS final_reply_message_id,reply.sent_at AS final_reply_at,run.owner_user_id,
      run.status AS run_status,COALESCE(source.invocation_input_version,source.entity_version) AS source_input_version,
      to_char(report.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM data.agent_message_executions report JOIN data.runs run ON run.run_id=report.run_id
      AND run.channel_id=report.channel_id
    JOIN data.messages source ON source.space_id=report.space_id AND source.channel_id=report.channel_id
      AND source.message_id=report.source_message_id
      AND report.source_entity_version BETWEEN COALESCE(source.invocation_input_version,source.entity_version) AND source.entity_version
      AND source.body_hash=report.source_body_hash AND source.timeline_sequence=report.source_sequence
      AND source.deleted_at IS NULL AND source.recalled_at IS NULL
    LEFT JOIN LATERAL (SELECT message.message_id,message.sent_at FROM data.messages message
      WHERE message.space_id=report.space_id AND message.channel_id=report.channel_id
        AND message.agent_final_reply_json IS NOT NULL
        AND message.agent_final_reply_json->>'runId'=report.run_id
        AND message.agent_final_reply_json->>'executionId'=report.execution_id
        AND message.agent_final_reply_json->>'instanceId'=report.instance_id
        AND message.agent_final_reply_json->>'bodyHash'=message.body_hash
        AND message.author_kind='agent' AND message.author_id=report.instance_id
        AND COALESCE(message.invocation_input_version,message.entity_version)=1
        AND message.deleted_at IS NULL AND message.recalled_at IS NULL
      ORDER BY message.timeline_sequence DESC LIMIT 1) reply ON true
    WHERE report.space_id=$1 AND report.channel_id=$2 AND report.source_message_id=ANY($3::text[])
      AND report.expires_at>clock_timestamp()
      AND ($4::timestamptz IS NULL OR (report.created_at,report.binding_id)>($4::timestamptz,$5::text))
      AND ($7::text IS NULL OR report.run_id=$7)
    ORDER BY report.created_at,report.binding_id LIMIT $6`, values: [input.spaceId, input.channelId,
      input.messageIds, input.position?.[0] ?? null, input.position?.[1] ?? null, input.limit + 1,
      input.runId ?? null], maxRows: input.limit + 1 });
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return { records: page.map(row => ({
    id: String(row.binding_id), channelId: String(row.channel_id), sourceMessageId: String(row.source_message_id),
    sourceEntityVersion: Number(row.source_entity_version), sourceInputVersion: Number(row.source_input_version), sourceBodyHash: String(row.source_body_hash),
    runId: String(row.run_id), instanceId: String(row.instance_id),
    ...(row.agent_name ? { agentName: String(row.agent_name) } : {}),
    ...(row.channel_instance_id ? { channelInstanceId: String(row.channel_instance_id) } : {}),
    executionId: String(row.execution_id), revision: Number(row.revision),
    state: row.state as SerializedAgentMessageExecution["state"],
    ...(row.input_disposition ? { inputDisposition: row.input_disposition } : {}),
    startedAt: new Date(Number(row.started_at_millis)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_millis)).toISOString(),
    ...(row.finished_at_millis !== null ? { finishedAt: new Date(Number(row.finished_at_millis)).toISOString() } : {}),
    observedAt: new Date(row.observed_at).toISOString(), runStatus: String(row.run_status),
    ...(input.viewerUserId && row.owner_user_id === input.viewerUserId && ["starting", "running"].includes(String(row.run_status)) &&
      TERMINAL.has(String(row.state)) ? { recoveryAvailable: true } : {}),
    ...(row.final_reply_message_id ? { finalReply: { messageId: String(row.final_reply_message_id),
      committedAt: new Date(row.final_reply_at).toISOString() } } : {}),
  })), next: rows.length > input.limit && last ? [String(last.cursor_at), String(last.binding_id)] : null };
}

/** Call only inside an already authenticated, Run-fenced Machine transaction. */
export async function recordMessageExecutions(tx: DatabaseTransaction, context: {
  spaceId: string; channelId: string; runId: string; instanceId?: string;
  agentName?: string; channelInstanceId?: string; at: string;
}, raw: unknown): Promise<void> {
  if (!context.instanceId || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const snapshot = cleanAgentRuntimeExecutions(raw as Record<string, unknown>);
  const reports = [...(snapshot.recentExecutions ?? []), ...(snapshot.execution ? [snapshot.execution] : [])];
  for (const report of reports) {
    if (!report.sources.length || report.sources.some(source => source.channelId !== context.channelId)) continue;
    // A Run's actor is its Instance; the digest keeps its original field layout.
    const bindingDigest = await hash([context.runId, context.instanceId, context.instanceId,
      report.executionId, report.sourceCount, report.sources, report.startedAtMillis]);
    const reportDigest = await hash(report);
    const prior = (await tx.query<QueryResultRow>({ name: "runtime_message_execution_prior_v1", text: `SELECT
      binding_digest,report_digest,revision,state FROM data.agent_message_executions
      WHERE run_id=$1 AND execution_id=$2 LIMIT 1`, values: [context.runId, report.executionId], maxRows: 1 }))[0];
    // Invalid/conflicting observation data cannot prevent the owning Run from
    // terminalizing. It also cannot replace an earlier execution's identity.
    if (prior && (prior.binding_digest !== bindingDigest || Number(prior.revision) > report.revision ||
        Number(prior.revision) === report.revision && prior.report_digest !== reportDigest ||
        TERMINAL.has(String(prior.state)) && Number(prior.revision) !== report.revision)) continue;
    if (prior && Number(prior.revision) === report.revision && TERMINAL.has(String(prior.state))) continue;
    if (!prior && TERMINAL.has(report.state) && report.updatedAtMillis < Date.parse(context.at) - RETENTION_MS) continue;
    const entries = await Promise.all(report.sources.map(async source => ({
      id: await hash([context.runId, report.executionId, source.messageId]),
      message_id: source.messageId, entity_version: source.entityVersion, body_hash: source.bodyHash,
      sequence: source.sequence,
    })));
    await tx.query({ name: "runtime_message_execution_upsert_v2", text: `WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS entry(id text,message_id text,
          entity_version bigint,body_hash text,sequence bigint)
      ), eligible AS (
        SELECT incoming.* FROM incoming JOIN data.messages message
          ON message.space_id=$2 AND message.channel_id=$3 AND message.message_id=incoming.message_id
          AND incoming.entity_version BETWEEN COALESCE(message.invocation_input_version,message.entity_version) AND message.entity_version
          AND message.body_hash=incoming.body_hash
          AND message.timeline_sequence=incoming.sequence AND message.deleted_at IS NULL AND message.recalled_at IS NULL
          AND $20::boolean
        UNION
        SELECT incoming.* FROM incoming JOIN data.agent_message_executions prior ON prior.binding_id=incoming.id
          AND prior.run_id=$4 AND prior.instance_id=$5 AND prior.binding_digest=$9
      ) INSERT INTO data.agent_message_executions
        (binding_id,space_id,channel_id,run_id,instance_id,agent_name,channel_instance_id,
         execution_id,binding_digest,report_digest,revision,source_message_id,source_entity_version,
         source_body_hash,source_sequence,source_count,state,input_disposition,started_at_millis,
         updated_at_millis,finished_at_millis,created_at,observed_at,expires_at)
      SELECT id,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,message_id,entity_version,body_hash,sequence,
        $12,$13,$14,$15,$16,$17,$18,$18,$19 FROM eligible
      ON CONFLICT (binding_id) DO UPDATE SET revision=EXCLUDED.revision,report_digest=EXCLUDED.report_digest,
        state=EXCLUDED.state,input_disposition=EXCLUDED.input_disposition,
        updated_at_millis=EXCLUDED.updated_at_millis,finished_at_millis=EXCLUDED.finished_at_millis,
        observed_at=GREATEST(agent_message_executions.observed_at,EXCLUDED.observed_at),
        expires_at=GREATEST(agent_message_executions.expires_at,EXCLUDED.expires_at)
      WHERE agent_message_executions.binding_digest=EXCLUDED.binding_digest
        AND agent_message_executions.revision<=EXCLUDED.revision
        AND agent_message_executions.state IN ('accepted','running')`,
      values: [JSON.stringify(entries), context.spaceId, context.channelId, context.runId, context.instanceId,
        context.agentName?.slice(0, 160) ?? null, context.channelInstanceId ?? null,
        report.executionId, bindingDigest, reportDigest, report.revision, report.sourceCount,
        report.state, report.inputDisposition ?? null, report.startedAtMillis, report.updatedAtMillis,
        report.finishedAtMillis ?? null, context.at, new Date(Date.parse(context.at) + RETENTION_MS).toISOString(), !prior], maxRows: 0 });
  }
}


/** Bounded Run selection after the caller has checked current Channel access. */
export async function selectRunExecutionSources(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; runId: string; triggerId?: string;
  explicit?: readonly string[]; limit: number;
}): Promise<{ sourceMessageIds: string[]; hasOlderMessages: boolean }> {
  const rows = await tx.query<QueryResultRow>({ name: "runtime_diagnostic_execution_sources_v1", text: `SELECT
      report.source_message_id,MAX(report.created_at) AS latest
    FROM data.agent_message_executions report JOIN data.messages source
      ON source.space_id=report.space_id AND source.channel_id=report.channel_id
      AND source.message_id=report.source_message_id
      AND report.source_entity_version BETWEEN COALESCE(source.invocation_input_version,source.entity_version) AND source.entity_version
      AND source.body_hash=report.source_body_hash AND source.timeline_sequence=report.source_sequence
      AND source.deleted_at IS NULL AND source.recalled_at IS NULL
    WHERE report.space_id=$1 AND report.channel_id=$2 AND report.run_id=$3
      AND report.expires_at>clock_timestamp()
      AND ($4::text[] IS NULL OR report.source_message_id=ANY($4::text[]))
    GROUP BY report.source_message_id ORDER BY latest DESC,report.source_message_id LIMIT $5`,
    values: [input.spaceId, input.channelId, input.runId, input.explicit ?? null,
      input.explicit ? 101 : input.limit + 1], maxRows: input.explicit ? 101 : input.limit + 1 });
  const ids = [...new Set([...(input.triggerId ? [input.triggerId] : []),
    ...rows.map(row => String(row.source_message_id))])];
  if (input.explicit) return { sourceMessageIds: input.explicit.filter(id => ids.includes(id)), hasOlderMessages: false };
  return { sourceMessageIds: ids.slice(0, input.limit), hasOlderMessages: ids.length > input.limit };
}

/** Acknowledges observation storage only; never changes Run lifecycle or grants. */
export async function acknowledgeMachineExecution(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; ownerUserId: string; machineId: string; hostId: string;
  payload: Record<string, unknown>; at: string;
}): Promise<Record<string, unknown>> {
  const fail = (code: string, status: 400 | 403 | 409, message: string): never => {
    throw new RuntimeControlError(code, status, message);
  };
  const scope = input.payload.scope as Record<string, unknown> | undefined;
  const report = cleanAgentRuntimeExecution(input.payload.report);
  const requestId = input.payload.requestId;
  if (input.payload.schemaVersion !== 1 || !scope || !report || !report.sources.length ||
      typeof requestId !== "string" || !/^[0-9a-f-]{36}$/u.test(requestId) ||
      ["runId", "instanceId", "agentId", "channelId"].some(key => typeof scope[key] !== "string" ||
        !scope[key] || utf8ByteLength(scope[key] as string) > 300) ||
      typeof scope.executionFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(scope.executionFingerprint) ||
      scope.channelId !== input.channelId || report.sources.some(source => source.channelId !== input.channelId)) {
    return fail("invalid_execution_report", 400, "Execution report identity or evidence is invalid");
  }
  const run = (await tx.query<QueryResultRow>({ name: "runtime_execution_report_owner_v4", text: `SELECT
      run.run_id,run.metadata_json,instance.instance_id,instance.channel_instance_id,
      COALESCE(registration.display_name,run.metadata_json->>'agentName') AS agent_name
    FROM data.runs run JOIN data.instances instance ON instance.run_id=run.run_id
      JOIN data.run_agent_registrations binding ON binding.run_id=run.run_id AND binding.space_id=$1
      LEFT JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
        AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
        AND registration.harness=binding.harness
      JOIN data.channels channel ON channel.channel_id=run.channel_id AND channel.space_id=$1
    WHERE run.run_id=$2 AND run.channel_id=$3 AND instance.instance_id=$4
      AND instance.channel_id=run.channel_id AND instance.instance_id=$5 AND run.owner_user_id=$6
      AND run.metadata_json->>'machineId'=$7
    LIMIT 1 FOR UPDATE OF run`, values: [input.spaceId, scope.runId, input.channelId, scope.instanceId, scope.agentId, input.ownerUserId, input.machineId], maxRows: 1 }))[0];
  const executionKey = run?.metadata_json?.executionKey;
  if (!run || typeof executionKey !== "string" || await sha256Hex(executionKey) !== scope.executionFingerprint) {
    return fail("execution_report_forbidden", 403, "Execution report requires its original Machine and Run binding");
  }
  const receipt = { requestId, runId: scope.runId, executionId: report.executionId, revision: report.revision };
  if (report.updatedAtMillis < Date.parse(input.at) - RETENTION_MS) return { ...receipt, status: "expired" };
  const context = { spaceId: input.spaceId, channelId: input.channelId, runId: String(run.run_id),
    instanceId: String(run.instance_id),
    agentName: run.agent_name ? String(run.agent_name) : undefined,
    channelInstanceId: String(run.channel_instance_id), at: input.at };
  await recordMessageExecutions(tx, context, report.finishedAtMillis === undefined
    ? { execution: report } : { recentExecutions: [report] });
  const stored = (await tx.query<QueryResultRow>({ name: "runtime_execution_report_receipt_v1", text: `SELECT
      binding_digest,report_digest,revision FROM data.agent_message_executions WHERE run_id=$1 AND execution_id=$2 LIMIT 1`,
    values: [scope.runId, report.executionId], maxRows: 1 }))[0];
  if (!stored) return { ...receipt, status: "source_unavailable" };
  const binding = await hash([scope.runId, scope.instanceId, scope.agentId, report.executionId,
    report.sourceCount, report.sources, report.startedAtMillis]);
  if (stored.binding_digest !== binding || Number(stored.revision) < report.revision ||
      Number(stored.revision) === report.revision && stored.report_digest !== await hash(report)) {
    return fail("execution_report_conflict", 409, "Execution report conflicts with existing evidence");
  }
  return { ...receipt, status: Number(stored.revision) === report.revision ? "recorded" : "superseded" };
}
