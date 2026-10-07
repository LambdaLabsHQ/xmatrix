import { requireRunRegistrationAccess } from "./agent-registration-run.js";
import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { DetailedControlError } from "./control-error.js";

const fail = (code: string, status: 400 | 403 | 409, message: string): never => {
  throw new DetailedControlError(code, status, message);
};

export function metadataRevision(metadata: Record<string, unknown> | null): number {
  const revision = metadata?.metadataRevision ?? 0;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) {
    return fail("metadata_revision_invalid", 409, "Channel metadata revision is invalid");
  }
  return Number(revision);
}

export interface MetadataContent {
  space_id: string; channel_id: string; name: string; metadata_json: Record<string, unknown> | null;
  updated_at: string | Date;
}
export interface MetadataWrite {
  actorUserId: string; commandId: string; at: string; expectedRevision?: number;
  summaryAuthor?: { runId: string; agentName: string; throughMessageId?: string };
  actorRunId?: string;
  restoreRevision?: number;
}

/** Proves About authority again inside the owning write/read transaction. */
export async function requireAboutRun(tx: DatabaseTransaction, channel: MetadataContent, runId: string,
  ownerUserId?: string): Promise<Record<string, unknown>> {
  const rows = await tx.query<QueryResultRow & { metadata_json: Record<string, unknown> }>({
    name: "channel_metadata_about_run_v1",
    text: `SELECT r.metadata_json FROM data.runs r
      JOIN data.run_agent_registrations registration ON registration.run_id=r.run_id
      JOIN data.space_members member ON member.space_id=registration.space_id AND member.user_id=r.owner_user_id
      WHERE r.run_id=$1 AND r.channel_id=$2 AND registration.space_id=$3
        AND ($4::text IS NULL OR r.owner_user_id=$4)
        AND r.status IN ('starting','running')
        AND r.metadata_json->>'routedAs'='management_channel_about'
        AND r.metadata_json->>'runtimeSessionId'=r.run_id
        AND member.role IN ('owner','admin') FOR SHARE OF r,registration,member`,
    values: [runId, channel.channel_id, channel.space_id, ownerUserId ?? null], maxRows: 1,
  });
  if (!rows[0]) return fail("channel_about_scope_invalid", 403, "Live About Run for this Channel required");
  await requireRunRegistrationAccess(tx, { runId, channelId: channel.channel_id, phase: "continuation",
    error: (code, status) => new DetailedControlError(code, status, "About registration is no longer authorized") });
  return rows[0].metadata_json;
}

/** Called only with the rows and metadata the authorized history statement read. */
export async function recordAboutInput(tx: DatabaseTransaction, input: {
  channel: MetadataContent; runId: string; references: Record<string, unknown>[]; contentRevision: number;
}): Promise<{ inputId: string; expectedRevision: number }> {
  await requireAboutRun(tx, input.channel, input.runId);
  const expectedRevision = metadataRevision(input.channel.metadata_json);
  const inputId = crypto.randomUUID();
  await tx.query({ name: "channel_about_input_insert_v1", text: `INSERT INTO data.channel_about_inputs
    (space_id,origin_space_id,channel_id,input_id,run_id,metadata_revision,snapshot_json,references_json,created_at)
    VALUES ($1,$1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,now())`,
    values: [input.channel.space_id,input.channel.channel_id,inputId,input.runId,expectedRevision,
      JSON.stringify({ name: input.channel.name, summary: input.channel.metadata_json?.summary ?? null,
        contentRevision: input.contentRevision,
        fromSequence: input.references.length ? Math.min(...input.references.map(ref => Number(ref.sequence))) : null,
        throughSequence: input.references.length ? Math.max(...input.references.map(ref => Number(ref.sequence))) : null,
      }), JSON.stringify(input.references)], maxRows: 0 });
  return { inputId, expectedRevision };
}

export async function appendMetadataRevision(tx: DatabaseTransaction, root: MetadataContent,
  next: MetadataContent, input: MetadataWrite): Promise<void> {
  const current = metadataRevision(root.metadata_json);
  let expected = input.expectedRevision;
  let source: Record<string, unknown> = { kind: "edit", actorUserId: input.actorUserId,
    commandId: input.commandId, ...(input.actorRunId ? { runId: input.actorRunId } : {}) };
  if (input.summaryAuthor) {
    const author = input.summaryAuthor;
    const run = await requireAboutRun(tx, root, author.runId, input.actorUserId);
    const inputs = await tx.query<QueryResultRow & { input_id: string; metadata_revision: string | number;
      has_through: boolean; from_sequence: string | number | null; through_sequence: string | number | null;
      created_at: Date | string }>({ name: "channel_about_input_sources_v1",
      text: `SELECT input_id,metadata_revision,created_at,
        snapshot_json->>'fromSequence' AS from_sequence,snapshot_json->>'throughSequence' AS through_sequence,
        EXISTS(SELECT 1 FROM jsonb_array_elements(references_json) ref WHERE ref->>'messageId'=$3) AS has_through
        FROM data.channel_about_inputs WHERE channel_id=$1 AND run_id=$2 ORDER BY created_at,input_id LIMIT 1001`,
      values: [root.channel_id, author.runId,author.throughMessageId ?? null], maxRows: 1001 });
    if (!inputs.length || inputs.length > 1000) return fail("channel_about_input_required", 409,
      "Read this Channel's authoritative history before saving About (at most 1000 pages)");
    expected ??= Number(inputs[0]!.metadata_revision);
    if (inputs.some((page) => Number(page.metadata_revision) !== expected)) return fail(
      "metadata_revision_conflict", 409, "About input spans different metadata revisions; start a fresh session");
    const through = author.throughMessageId;
    if (!through || !inputs.some((page) => page.has_through)) {
      return fail("channel_about_input_mismatch", 403, "throughMessageId must belong to this Run's recorded input");
    }
    // Both ids came from the launch authority, never from the writer's patch.
    source = { ...source, kind: "about", runId: author.runId, agentName: author.agentName,
      triggerRequestId: run.channelAboutTriggerRequestId ?? null,
      triggerMessageId: run.channelAboutTriggerMessageId ?? null,
      throughMessageId: through, inputIds: inputs.map((page) => page.input_id),
      inputReadFrom: new Date(inputs[0]!.created_at).toISOString(),
      inputReadThrough: new Date(inputs[inputs.length - 1]!.created_at).toISOString(),
      coverage: {
        fromSequence: Math.min(...inputs.filter(page => page.from_sequence !== null).map(page => Number(page.from_sequence))),
        throughSequence: Math.max(...inputs.filter(page => page.through_sequence !== null).map(page => Number(page.through_sequence))),
      } };
    if (typeof source.triggerMessageId === "string") {
      const trigger = await tx.query({ name: "channel_about_trigger_scope_v1", text: `SELECT message_id FROM data.messages
        WHERE space_id=$1 AND channel_id=$2 AND message_id=$3`,
        values: [root.space_id,root.channel_id,source.triggerMessageId], maxRows: 1 });
      if (!trigger[0]) return fail("channel_about_input_mismatch", 403, "About trigger is outside this Channel");
    }
  }
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) return fail(
    "invalid_command", 400, "expectedRevision must be a non-negative safe integer");
  if (expected !== undefined && expected !== current) return fail(
    "metadata_revision_conflict", 409, "Channel metadata changed; read its current revision and retry");
  if (input.restoreRevision !== undefined) source = { ...source, kind: "restore", restoredFromRevision: input.restoreRevision };
  const insert = async (channel: MetadataContent, revision: number, provenance: Record<string, unknown>,
    parent: number | null, at: string | Date, baseline = false) => tx.query({
    name: baseline ? "channel_metadata_baseline_v1" : "channel_metadata_append_v1",
    text: `INSERT INTO data.channel_metadata_revisions
      (space_id,origin_space_id,channel_id,revision,parent_revision,name,summary,auto_name,summary_source_json,source_json,created_at)
      VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) ${baseline ? "ON CONFLICT DO NOTHING" : ""}`,
    values: [channel.space_id,channel.channel_id,revision,parent,channel.name,
      channel.metadata_json?.summary ?? null,channel.metadata_json?.autoName === true,
      JSON.stringify(channel.metadata_json?.summarySource ?? null),JSON.stringify(provenance),at], maxRows: 0 });
  if (current === 0) await insert(root, 0, { kind: "baseline", provenanceKnown: false }, null, root.updated_at, true);
  next.metadata_json ??= {};
  next.metadata_json.metadataRevision = current + 1;
  await insert(next, current + 1, source, current, input.at);
}
