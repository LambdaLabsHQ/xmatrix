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
/**
 * The one harness execution that wrote an About from the conversation the Hub read for it
 * (channel-about.ts in the Hub): the metadata revision it read and the newest message it was given.
 */
export interface AboutTaskAuthor { taskId: string; agentName: string; readRevision: number; throughSequence: number }

export interface MetadataWrite {
  actorUserId: string; commandId: string; at: string; expectedRevision?: number;
  summaryAuthor?: AboutTaskAuthor;
  actorRunId?: string;
  restoreRevision?: number;
}

export async function appendMetadataRevision(tx: DatabaseTransaction, root: MetadataContent,
  next: MetadataContent, input: MetadataWrite): Promise<void> {
  const current = metadataRevision(root.metadata_json);
  const expected = input.expectedRevision;
  let source: Record<string, unknown> = { kind: "edit", actorUserId: input.actorUserId,
    commandId: input.commandId, ...(input.actorRunId ? { runId: input.actorRunId } : {}) };
  if (input.summaryAuthor) {
    const task = input.summaryAuthor;
    // What changed the About after the task read the conversation stands: a person's edit, or an
    // About that read as far or further. An older reading never replaces a newer one.
    const later = await tx.query({ name: "channel_about_task_superseded_v1", text: `SELECT 1
      FROM data.channel_metadata_revisions WHERE channel_id=$1 AND revision>$2
        AND (source_json->>'kind' IS DISTINCT FROM 'about_task' OR (source_json->>'throughSequence')::bigint>=$3)
      LIMIT 1`, values: [root.channel_id, task.readRevision, task.throughSequence], maxRows: 1 });
    if (later[0]) return fail("metadata_revision_conflict", 409, "The About changed after this task read the conversation");
    source = { kind: "about_task", actorUserId: input.actorUserId, commandId: input.commandId, taskId: task.taskId,
      agentName: task.agentName, readRevision: task.readRevision, throughSequence: task.throughSequence };
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
