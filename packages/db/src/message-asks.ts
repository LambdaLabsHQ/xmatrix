import { digestCanonicalCloneCborV1, parseConnectorInvocation, parseMessageInteraction, type SerializedMessageAsk } from "@xmatrix/protocol";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabasePlacementContext } from "./context.js";
import { channelCapabilityPredicate, requireChannelCapability } from "./channel-capability-policy.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";
import { ControlError } from "./control-error.js";
import { requireRoutableHarness } from "./first-message-launch-choice.js";
import type { QueryResultRow } from "pg";

/** Conservative receipt: a message with a recipient or an interpretation owner
 * never becomes a new launch. In particular this does not resume stopped Agents. */
function messageCanOfferAsk(body: string): boolean {
  const plan = parseMessageInteraction(body);
  return !parseConnectorInvocation(body) && !plan.refused && !plan.stop && !plan.controls.length &&
    !plan.reborn.length && !plan.handoff.length && !plan.launches.length && !plan.mentions.length;
}

// Live delivery and #952 retain ownership even while their transport is offline.
const RECEIVER_SQL = `EXISTS (SELECT 1 FROM data.instances i WHERE i.channel_id=m.channel_id
  AND (i.status IN ('online','busy','idle') OR i.rest_state IN ('sleeping','interrupted')))
  OR EXISTS (SELECT 1 FROM data.runs r WHERE r.channel_id=m.channel_id AND r.status IN ('starting','running'))
  OR m.agent_invocation_targets_json IS NOT NULL
  OR EXISTS (SELECT 1 FROM data.message_attention a WHERE a.space_id=m.space_id AND a.channel_id=m.channel_id
    AND a.message_id=m.message_id AND a.subject_id LIKE 'user:%' AND a.kind IN ('mention','reply','broadcast'))
  OR EXISTS (SELECT 1 FROM data.automation_occurrences occurrence WHERE occurrence.message_id=m.message_id)`;

// The first-message decision owns a new unnamed conversation from append,
// including the gap before its row is inserted. A failed undecided reading
// may be explicitly claimed; a decision of none is never reopened.
const DECISION_OWNS_SQL = `EXISTS (SELECT 1 FROM data.first_message_launch_choices choice
    WHERE choice.channel_id=m.channel_id AND choice.message_id=m.message_id
      AND (choice.choice IS NOT NULL OR choice.failure_code IS NULL))
  OR (m.timeline_sequence=1 AND c.metadata_json->>'welcome' IS DISTINCT FROM 'true'
    AND (c.metadata_json->>'autoName' IS NOT DISTINCT FROM 'true'
      OR COALESCE(c.metadata_json->>'fromPageId','')<>''
      OR (COALESCE(c.metadata_json->>'fromChannelId','')<>'' AND COALESCE(c.metadata_json->>'fromMessageId','')<>''))
    AND NOT EXISTS (SELECT 1 FROM data.first_message_launch_choices failed
      WHERE failed.channel_id=m.channel_id AND failed.message_id=m.message_id AND failed.failure_code IS NOT NULL))`;

/** Caller owns the canonical Human append and Channel lock in this transaction.
 * Evidence commits atomically with the publication; post-commit cannot invent it.
 * An absent witness or an older uncertified row remains unknown. */
export async function recordMessageAskAtAppend(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; messageId: string; actorUserId: string; body: string;
}): Promise<void> {
  if (!messageCanOfferAsk(input.body)) return;
  const hash = await digestCanonicalCloneCborV1(input.body);
  await tx.query({
      name: "message_ask_append_witness_v1", text: `INSERT INTO data.message_asks
        (space_id,channel_id,message_id,author_user_id,input_version,body_hash,commit_certified)
        SELECT m.space_id,m.channel_id,m.message_id,m.author_id,COALESCE(m.invocation_input_version,m.entity_version),m.body_hash,TRUE
        FROM data.messages m JOIN data.channels c USING (space_id,channel_id)
        WHERE m.space_id=$1 AND m.channel_id=$2 AND m.message_id=$3 AND m.author_kind='user' AND m.author_id=$4
          AND m.message_kind='xmatrix.message.text' AND m.body_hash=$5
          AND ($6::boolean OR COALESCE(jsonb_array_length(m.attachments_json),0)>0)
          AND m.edited_at IS NULL AND m.recalled_at IS NULL AND m.deleted_at IS NULL
          AND m.sent_at>clock_timestamp()-interval '1 minute'
          AND NOT (${RECEIVER_SQL})
        ON CONFLICT (channel_id,message_id) DO NOTHING`,
      values: [input.spaceId, input.channelId, input.messageId, input.actorUserId, hash, !!input.body.trim()], maxRows: 0,
  });
}

export class PostgresMessageAskRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly placement: DatabasePlacementContext) {}

  private transaction<T>(requestId: string, operation: string, channelId: string, actorUserId: string,
    callback: (tx: DatabaseTransaction) => Promise<T>) {
    return this.database.transaction({ requestId, operation, placement: this.placement }, async tx => {
      await requireChannelCapability(tx, { spaceId: this.placement.spaceId, channelId,
        principal: { kind: "user", id: actorUserId }, capability: "runtime_new_work",
        error: failure => new RegistrationAccessError(failure.code, failure.status) });
      return callback(tx);
    });
  }

  /** An explicit Human selection claims the SAME per-message decision as Jev.
   * The Channel lock, source lock and unique decision serialize edits, grant
   * changes, two devices, and a delayed first-message reader. */
  async claim(input: { requestId: string; channelId: string; messageId: string; actorUserId: string;
    body: string; harness: string }): Promise<void> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(input.harness)) throw new RegistrationAccessError("invalid_launch_choice", 400);
    const hash = await digestCanonicalCloneCborV1(input.body);
    await this.transaction(input.requestId, "message-ask.claim", input.channelId, input.actorUserId, async tx => {
      const [source] = await tx.query<QueryResultRow>({ name: "message_ask_claim_source_v2", text: `SELECT ask.input_version
        FROM data.message_asks ask JOIN data.messages m USING (space_id,channel_id,message_id)
        JOIN data.channels c USING (space_id,channel_id)
        WHERE ask.space_id=$1 AND ask.channel_id=$2 AND ask.message_id=$3 AND ask.author_user_id=$4 AND ask.commit_certified IS TRUE
          AND m.author_kind='user' AND m.author_id=$4 AND m.body_hash=$5 AND ask.body_hash=m.body_hash
          AND ask.input_version=COALESCE(m.invocation_input_version,m.entity_version)
          AND m.recalled_at IS NULL AND m.deleted_at IS NULL AND m.edited_at IS NULL
          AND NOT (${RECEIVER_SQL}) FOR SHARE OF m`,
      values: [this.placement.spaceId, input.channelId, input.messageId, input.actorUserId, hash], maxRows: 1 });
      // A replay may happen after admission made a receiver. Its exact choice
      // is reconciled below, but a stale/withdrawn source still fails closed.
      if (!source) {
        if (await this.replay(tx, input, hash)) return;
        throw new ControlError("message_ask_unavailable", 409, "This message changed or already has an Agent. Refresh the conversation before choosing again.");
      }
      await requireRoutableHarness(tx, this.placement.spaceId, input.harness);
      await tx.query({ name: "message_ask_choice_open_v1", text: `INSERT INTO data.first_message_launch_choices
        (space_id,channel_id,message_id,author_user_id,deadline_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp(),clock_timestamp())
        ON CONFLICT (channel_id,message_id) DO NOTHING`,
      values: [this.placement.spaceId, input.channelId, input.messageId, input.actorUserId], maxRows: 0 });
      await tx.query({ name: "message_ask_choice_claim_v1", text: `UPDATE data.first_message_launch_choices
        SET choice='start',chosen_harness=$5,chosen_by='author',chosen_at=clock_timestamp(),failure_code=NULL,
          updated_at=clock_timestamp(),source_input_version=$6,source_body_hash=$7
        WHERE space_id=$1 AND channel_id=$2 AND message_id=$3 AND author_user_id=$4 AND choice IS NULL
          AND (failure_code IS NOT NULL OR recommendation IS NULL)`,
      values: [this.placement.spaceId, input.channelId, input.messageId, input.actorUserId, input.harness, source.input_version, hash], maxRows: 0 });
      if (!await this.replay(tx, input, hash)) throw new ControlError("launch_choice_taken", 409, "This message already has a decision. Refresh the conversation to see it.");
    });
  }

  private async replay(tx: DatabaseTransaction, input: { channelId: string; messageId: string; actorUserId: string; harness: string }, hash: string) {
    const rows = await tx.query({ name: "message_ask_choice_replay_v2", text: `SELECT 1 FROM data.first_message_launch_choices choice
      JOIN data.message_asks ask USING (space_id,channel_id,message_id)
      JOIN data.messages m USING (space_id,channel_id,message_id)
      WHERE choice.space_id=$1 AND choice.channel_id=$2 AND choice.message_id=$3 AND choice.author_user_id=$4
        AND ask.commit_certified IS TRUE AND choice.choice='start' AND choice.chosen_by='author' AND choice.chosen_harness=$5 AND choice.failure_code IS NULL
        AND m.author_kind='user' AND m.author_id=$4 AND m.body_hash=$6 AND ask.body_hash=m.body_hash
        AND ask.input_version=COALESCE(m.invocation_input_version,m.entity_version)
        AND m.edited_at IS NULL AND m.recalled_at IS NULL AND m.deleted_at IS NULL FOR SHARE OF m`,
    values: [this.placement.spaceId, input.channelId, input.messageId, input.actorUserId, input.harness, hash], maxRows: 1 });
    return !!rows.length;
  }
}

/** Caller authorized history. No evidence means unknown. Only the author gets
 * an action, and a later recipient or settled decision removes it. */
export async function readMessageAsks(tx: DatabaseTransaction, channelId: string, messageIds: readonly string[], actorUserId: string): Promise<SerializedMessageAsk[]> {
  if (!messageIds.length) return [];
  const rows = await tx.query<QueryResultRow>({ name: "message_ask_read_v2", text: `SELECT ask.message_id,
      NOT (${RECEIVER_SQL}) AND NOT (${DECISION_OWNS_SQL}) AND
      ${channelCapabilityPredicate({ capability: "runtime_new_work", channelAlias: "c", principalKindSql: "'user'", principalIdSql: "$3" })}
      AS can_ask FROM data.message_asks ask
    JOIN data.messages m USING (space_id,channel_id,message_id) JOIN data.channels c USING (space_id,channel_id)
    WHERE ask.channel_id=$1 AND ask.message_id=ANY($2::text[]) AND ask.author_user_id=$3 AND ask.commit_certified IS TRUE
      AND m.author_kind='user' AND m.author_id=$3 AND ask.body_hash=m.body_hash
      AND ask.input_version=COALESCE(m.invocation_input_version,m.entity_version)
      AND m.edited_at IS NULL AND m.recalled_at IS NULL AND m.deleted_at IS NULL
      ORDER BY ask.message_id LIMIT 100`,
  values: [channelId, messageIds, actorUserId], maxRows: 100 });
  return rows.map(row => ({ channelId, messageId: String(row.message_id), state: "unaddressed", canAsk: row.can_ask === true }));
}
