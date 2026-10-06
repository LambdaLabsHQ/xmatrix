import type { QueryResultRow } from "pg";
import { messagePublicationEvidence, type AgentRuntimeMessageSource } from "@xmatrix/protocol";
import type { DatabaseTransaction } from "./contracts.js";

/** Caller has authorized Channel launch creation in this same transaction.
 * Only an unchanged original publication can be the invocation source. */
export async function initialMessageSource(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; messageId: string; actorUserId: string;
}): Promise<AgentRuntimeMessageSource | undefined> {
  const row = (await tx.query<QueryResultRow>({ name: "runtime_initial_message_source_v4", text: `SELECT
      message.entity_version,message.body_hash,message.timeline_sequence
    FROM data.messages message WHERE message.space_id=$1 AND message.channel_id=$2 AND message.message_id=$3
      AND COALESCE(message.invocation_input_version,message.entity_version)=1
      AND message.edited_at IS NULL AND message.deleted_at IS NULL AND message.recalled_at IS NULL
      AND ((message.author_kind='user' AND message.author_id=$4) OR (message.author_kind='agent'
        AND EXISTS (SELECT 1 FROM data.instances author_instance
          JOIN data.run_agent_registrations author_run ON author_run.run_id=author_instance.run_id
          WHERE author_instance.instance_id=message.author_id
            AND author_run.space_id=$1 AND author_run.owner_user_id=$4))
        OR (message.author_kind='system' AND message.author_id='xmatrix' AND EXISTS (SELECT 1
          FROM data.first_message_launch_choices choice WHERE choice.space_id=$1 AND choice.channel_id=$2
            AND $3='xmatrix-summon:'||choice.message_id AND choice.author_user_id=$4 AND choice.choice='start'))) LIMIT 1`,
    values: [input.spaceId,input.channelId,input.messageId,input.actorUserId], maxRows: 1 }))[0];
  if (!row) return undefined;
  const publication = messagePublicationEvidence({ entityVersion: Number(row.entity_version), bodyHash: row.body_hash });
  const sequence = Number(row.timeline_sequence);
  return publication && Number.isSafeInteger(sequence) && sequence > 0
    ? { ...publication, channelId: input.channelId, messageId: input.messageId, sequence } : undefined;
}

/** Strip caller-supplied provenance before replay comparison or persistence. */
export function withInitialMessageSource(payload: Record<string, unknown>, source?: AgentRuntimeMessageSource): Record<string, unknown> {
  const context = payload.context && typeof payload.context === "object" && !Array.isArray(payload.context)
    ? payload.context as Record<string, unknown> : {};
  const { initialMessageSource: _untrusted, ...rest } = context;
  const { context: _context, ...base } = payload;
  const next = { ...rest, ...(source ? { initialMessageSource: source } : {}) };
  return { ...base, ...(Object.keys(next).length ? { context: next } : {}) };
}
