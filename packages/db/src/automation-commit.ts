import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { writeOutbox } from "./outbox.js";
import { ControlError } from "./control-error.js";

const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/** Outbox aggregate_kind and entity-directory kind for an Automation. */
const AUTOMATION_AGGREGATE_KIND = "automation";

export class AutomationControlError extends ControlError {
  override name = "AutomationControlError";
}

/**
 * Commits one Automation change on its Space's control head: the outbox fact
 * projections read, and the command's replay record.
 */
export async function commitAutomationChange(tx: DatabaseTransaction, spaceId: string, commandId: string, kind: string,
  requestDigest: string, value: Record<string, unknown>, at: string) {
  const heads = await tx.query<QueryResultRow>({ name: "automation_control_head_v1", text: `UPDATE
    data.space_control_heads SET commit_sequence=commit_sequence+1,updated_at=$2 WHERE space_id=$1
    RETURNING commit_sequence`, values: [spaceId, at], maxRows: 1 });
  if (!heads[0]) throw new AutomationControlError(
    "space_control_head_missing", 500, "Space control head is unavailable");
  const sequence = Number(heads[0].commit_sequence);
  await writeOutbox(tx, {
    name: "automation_outbox_v2",
    outboxId: `space-control:${spaceId}:${sequence}`,
    spaceId,
    topic: "space-control",
    aggregateKind: AUTOMATION_AGGREGATE_KIND,
    aggregateId: String(value.entityId ?? spaceId),
    aggregateSequence: sequence,
    payload: value,
    at,
  });
  await tx.query({ name: "automation_replay_write_v1", text: `INSERT INTO
    control.scoped_control_command_replays
    (scope_kind,scope_id,command_id,command_kind,request_digest,result_json,created_at,expires_at)
    VALUES ('space',$1,$2,$3,$4,$5::jsonb,$6,$7)`, values: [spaceId, commandId, kind,
    requestDigest, JSON.stringify(value), at,
    new Date(Date.parse(at) + REPLAY_TTL_MS).toISOString()], maxRows: 0 });
}
