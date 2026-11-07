import type { DatabaseTransaction } from "./contracts.js";
import { queryMessageExecutions } from "./runtime-message-executions.js";
import type { ShadowEvidence } from "./norn-shadow-values.js";

/** Reads only an explicitly selected binding. No name/prompt matching or backfill. */
export async function nornShadowSource(tx: DatabaseTransaction, scope: { spaceId: string; channelId: string }, bindingId: string) {
  const [binding] = await tx.query({ name: "norn_shadow_source_binding_v1",text: `SELECT report.source_message_id,report.run_id
    FROM data.agent_message_executions report JOIN data.messages source
      ON source.space_id=report.space_id AND source.channel_id=report.channel_id AND source.message_id=report.source_message_id
    JOIN data.runs run ON run.run_id=report.run_id
    WHERE report.space_id=$1 AND report.channel_id=$2 AND report.binding_id=$3 LIMIT 1 FOR SHARE OF report,source,run`,
    values: [scope.spaceId,scope.channelId,bindingId],maxRows: 1 });
  if (!binding) return null;
  const { records } = await queryMessageExecutions(tx,{ ...scope,messageIds: [String(binding.source_message_id)],
    runId: String(binding.run_id),bindingId,limit: 1 });
  const source = records[0];
  if (!source) return null;
  if (source.finalReply) {
    const valid = await tx.query({ name: "norn_shadow_final_receipt_lock_v1",text: `SELECT 1 FROM data.messages
      WHERE space_id=$1 AND channel_id=$2 AND message_id=$3 AND author_kind='agent' AND author_id=$4
        AND agent_final_reply_json->>'runId'=$5 AND agent_final_reply_json->>'executionId'=$6
        AND agent_final_reply_json->>'instanceId'=$4 AND agent_final_reply_json->>'bodyHash'=body_hash
        AND COALESCE(invocation_input_version,entity_version)=1 AND deleted_at IS NULL AND recalled_at IS NULL FOR SHARE`,
      values: [scope.spaceId,scope.channelId,source.finalReply.messageId,source.instanceId,source.runId,source.executionId],maxRows: 1 });
    if (!valid.length) return null;
  }
  const generation = JSON.stringify([source.sourceBodyHash,source.sourceInputVersion,source.runId,source.instanceId,source.executionId]);
  const evidence: Omit<ShadowEvidence,"observedAt"> = { id: JSON.stringify([source.id,source.revision,source.finalReply?.messageId ?? null]),
    runId: source.runId,instanceId: source.instanceId,executionId: source.executionId,
    finalReplyId: source.finalReply?.messageId ?? null,declaration: source.state };
  return { source,generation,evidence };
}
