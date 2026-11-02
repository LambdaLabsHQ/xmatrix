import {
  digestCanonicalCloneCborV1,
  preparationRejectionMessage,
  type AgentQuotaRetry,
  type AgentQuotaRetryAdmission,
  type SpaceAgentRegistrationKey,
} from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";
import type { DatabasePlacementContext } from "./context.js";
import {
  channelCapabilityPredicate,
  lockChannelLifecycle,
  requireChannelCapability,
} from "./channel-capability-policy.js";
import { messageAuthoredForActor } from "./message-invocation-selections.js";
export interface QuotaRetryWork extends QueryResultRow {
  retry_id: string;
  actor_user_id: string;
  source_message_id: string;
  source_mention: string;
  source_sequence: string;
  selection_index: number;
  kind: "launch" | "continuation";
  source_instance_id: string | null;
  source_run_id: string | null;
  registrations_json: SpaceAgentRegistrationKey[];
  generation: number;
  state: AgentQuotaRetry["state"];
  created_at: Date;
  expires_at: Date;
  /** The reading that refused: only a newer one can start the retry. */
  refused_through: Date | null;
  /** An original summon still being checked, and so started by a reading
   * that clears it, until this instant. Never set on a continuation. */
  verify_until: Date | null;
  /** Moves with every wake; a check that read an older one cannot put the
   * retry back to sleep. NULL is no wake yet. */
  wake_revision: string | number | null;
}
// A source publication and, for continuation, its exact stopped Instance still
// own the work. A later successful handoff or reborn retires the old offer.
const CURRENT_SQL = `EXISTS (SELECT 1 FROM data.messages m WHERE m.space_id=q.space_id
  AND m.channel_id=q.channel_id AND m.message_id=q.source_message_id
  AND COALESCE(m.invocation_input_version,m.entity_version)=q.source_input_version AND m.body_hash=q.source_body_hash
  AND m.deleted_at IS NULL AND m.recalled_at IS NULL)
  AND (q.kind='launch' OR (EXISTS (SELECT 1 FROM data.instances i JOIN data.runs r ON r.run_id=i.run_id
    WHERE i.instance_id=q.source_instance_id AND i.channel_id=q.channel_id AND r.owner_user_id=q.actor_user_id
      AND (r.run_id=q.source_run_id OR EXISTS (SELECT 1 FROM data.agent_reborn_intents own
        WHERE own.channel_id=q.channel_id AND own.source_run_id=q.source_run_id AND own.successor_run_id=r.run_id
          AND own.run_input_json->'quotaRetry'->>'id'=q.retry_id
          AND (own.run_input_json->'quotaRetry'->>'generation')::integer=q.generation)))
    AND NOT EXISTS (SELECT 1 FROM data.agent_launches l WHERE l.channel_id=q.channel_id
      AND l.trigger_id=q.source_message_id)
    AND NOT EXISTS (SELECT 1 FROM data.runs successor WHERE successor.channel_id=q.channel_id
      AND successor.metadata_json->>'handoffSourceInstanceId'=q.source_instance_id AND successor.created_at>=q.created_at)
    AND NOT EXISTS (SELECT 1 FROM data.messages newer WHERE newer.space_id=q.space_id AND newer.channel_id=q.channel_id
      AND newer.timeline_sequence>q.source_sequence AND newer.message_kind='xmatrix.message.text'
      AND newer.author_kind='user' AND newer.deleted_at IS NULL AND newer.recalled_at IS NULL
      AND newer.agent_invocation_targets_json->'targets' @> jsonb_build_array(jsonb_build_object('instanceId',q.source_instance_id)))))`;
const failure = (f: { code: string; status: number }) => new RegistrationAccessError(f.code, f.status);
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
/** Called under the same Channel lock as final launch/reborn admission.
 * A queued choice is no substitute for normal current registration admission. */
export async function assertQuotaRetryAdmission(
  tx: DatabaseTransaction,
  input: {
    channelId: string;
    actorUserId: string;
    admission?: AgentQuotaRetryAdmission;
    sourceMessageId?: string;
    selectionIndex?: number;
    sourceInstanceId?: string;
  },
): Promise<void> {
  if (!input.admission) return;
  const rows = await tx.query({
    name: "quota_retry_admission_v1",
    text: `SELECT 1 FROM data.agent_quota_retries q
    WHERE q.channel_id=$1 AND q.retry_id=$2 AND q.actor_user_id=$3 AND q.generation=$4
      AND q.state IN ('dispatching','dispatched') AND q.expires_at>clock_timestamp() AND ${CURRENT_SQL}
      AND ($5::text IS NULL OR q.source_message_id=$5) AND ($6::integer IS NULL OR q.selection_index=$6)
      AND ($7::text IS NULL OR q.source_instance_id=$7) FOR UPDATE OF q`,
    values: [
      input.channelId,
      input.admission.id,
      input.actorUserId,
      input.admission.generation,
      input.sourceMessageId ?? null,
      input.selectionIndex ?? null,
      input.sourceInstanceId ?? null,
    ],
    maxRows: 1,
  });
  if (!rows.length) throw new RegistrationAccessError("quota_retry_cancelled", 409);
}
/** An original summon whose refusal is still being checked: it is processed
 * like a waiting retry without its author choosing to wait. */
const VERIFYING_SQL = `(q.state='offered' AND q.kind='launch' AND q.verify_until>clock_timestamp())`;
/** A retry a reading may start: one waiting for quota, or one still verifying. */
const WAKEABLE_SQL = `q.expires_at>clock_timestamp() AND (q.state='waiting' OR ${VERIFYING_SQL})`;
export class PostgresQuotaRetryRepository {
  constructor(
    private readonly database: AuthorityDatabase,
    private readonly placement: DatabasePlacementContext,
  ) {}
  private transaction<T>(
    channelId: string,
    actorUserId: string,
    action: string,
    work: (tx: DatabaseTransaction) => Promise<T>,
  ) {
    return this.database.transaction(
      {
        requestId: `quota-retry:${crypto.randomUUID()}`,
        operation: `quota-retry.${action}`,
        placement: this.placement,
      },
      async (tx) => {
        await requireChannelCapability(tx, {
          spaceId: this.placement.spaceId,
          channelId,
          principal: { kind: "user", id: actorUserId },
          capability: "runtime_new_work",
          error: failure,
        });
        return work(tx);
      },
    );
  }
  async offer(input: {
    channelId: string;
    actorUserId: string;
    sourceMessageId: string;
    sourceMention: string;
    sourceBodyHash?: string;
    selectionIndex: number;
    registrations: SpaceAgentRegistrationKey[];
    continuation?: {
      instanceId: string;
      runId: string;
    };
    /** The reading that refused: only a newer one can start the retry. */
    refusedThrough?: string;
    /** An original summon is checked this long: a reading that clears it
     * within the window starts it without its author choosing to wait. */
    verifyForMs?: number;
  }): Promise<string> {
    if (
      !input.registrations.length ||
      input.registrations.length > 100 ||
      input.registrations.some((k) => k.spaceId !== this.placement.spaceId)
    )
      throw new RegistrationAccessError("invalid_quota_retry", 400);
    return this.transaction(input.channelId, input.actorUserId, "offer", async (tx) => {
      const [source] = await tx.query<QueryResultRow>({
        name: "quota_retry_offer_source_v1",
        text: `SELECT
        author_kind,author_id,body_hash,COALESCE(invocation_input_version,entity_version) AS input_version,timeline_sequence
        FROM data.messages WHERE space_id=$1 AND channel_id=$2 AND message_id=$3
          AND recalled_at IS NULL AND deleted_at IS NULL FOR SHARE`,
        values: [this.placement.spaceId, input.channelId, input.sourceMessageId],
        maxRows: 1,
      });
      if (
          !source || (input.sourceBodyHash !== undefined && source.body_hash !== input.sourceBodyHash) ||
        !(await messageAuthoredForActor(tx, {
          spaceId: this.placement.spaceId,
          channelId: input.channelId,
          messageId: input.sourceMessageId,
          authorKind: source.author_kind,
          authorId: source.author_id,
          actorUserId: input.actorUserId,
        }))
      )
        throw new RegistrationAccessError("invocation_source_unavailable", 409);
      const kind = input.continuation ? "continuation" : "launch";
      const id = await digestCanonicalCloneCborV1([
        this.placement.spaceId,
        input.channelId,
        input.sourceMessageId,
        Number(source.input_version),
        input.selectionIndex,
        kind,
      ]);
      await tx.query({
        name: "quota_retry_offer_v1",
        text: `INSERT INTO data.agent_quota_retries
        (space_id,channel_id,retry_id,actor_user_id,source_message_id,source_input_version,source_body_hash,source_sequence,
         source_mention,selection_index,kind,source_instance_id,source_run_id,registrations_json,expires_at,
         refused_through,verify_until)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,clock_timestamp()+interval '35 days',
          $15::timestamptz,CASE WHEN $11='launch' AND $16::integer>0
            THEN clock_timestamp()+make_interval(secs=>$16::integer/1000.0) END)
        ON CONFLICT (channel_id,retry_id) DO NOTHING`,
        values: [
          this.placement.spaceId,
          input.channelId,
          id,
          input.actorUserId,
          input.sourceMessageId,
          source.input_version,
          source.body_hash,
          source.timeline_sequence,
          input.sourceMention,
          input.selectionIndex,
          kind,
          input.continuation?.instanceId ?? null,
          input.continuation?.runId ?? null,
          JSON.stringify(input.registrations),
          input.refusedThrough && Number.isFinite(Date.parse(input.refusedThrough))
            ? new Date(input.refusedThrough).toISOString() : null,
          Math.max(0, Math.min(Math.trunc(input.verifyForMs ?? 0), 600_000)),
        ],
        maxRows: 0,
      });
      return id;
    });
  }
  async read(input: { channelId: string; actorUserId: string; id: string }): Promise<AgentQuotaRetry> {
    return this.database.transaction(
      {
        requestId: crypto.randomUUID(),
        operation: "quota-retry.read",
        placement: this.placement,
      },
      async (tx) => {
        await requireChannelCapability(tx, {
          spaceId: this.placement.spaceId,
          channelId: input.channelId,
          principal: { kind: "user", id: input.actorUserId },
          capability: "runtime_history_read",
          error: failure,
        });
        const [row] = await tx.query<QueryResultRow>({
          name: "quota_retry_read_v1",
          text: `SELECT q.*,${CURRENT_SQL} AS current,
        ${channelCapabilityPredicate({ capability: "runtime_new_work", channelAlias: "c", principalKindSql: "'user'", principalIdSql: "$3" })} AS authorized
        FROM data.agent_quota_retries q JOIN data.channels c USING (space_id,channel_id)
        WHERE q.space_id=$4 AND q.channel_id=$1 AND q.retry_id=$2`,
          values: [input.channelId, input.id, input.actorUserId, this.placement.spaceId],
          maxRows: 1,
        });
        if (!row) throw new RegistrationAccessError("quota_retry_not_found", 404);
        const valid = row.current === true && Date.parse(String(row.expires_at)) > Date.now();
        return {
          id: input.id,
          state: valid ? row.state : row.state === "offered" || row.state === "waiting" ? "expired" : row.state,
          canChoose: valid && row.authorized === true && row.actor_user_id === input.actorUserId,
          expiresAt: iso(row.expires_at),
          ...(row.next_check_at ? { nextCheckAt: iso(row.next_check_at) } : {}),
          ...(row.state === "failed" ? { failureMessage: preparationRejectionMessage(String(row.last_error_code)) ??
            "Automatic retry could not start. Check the task and Agent before trying again." } : {}),
        };
      },
    );
  }
  async choose(input: {
    channelId: string;
    actorUserId: string;
    id: string;
    action: "wait" | "cancel";
  }): Promise<void> {
    await this.transaction(input.channelId, input.actorUserId, "choose", async (tx) => {
      const [row] = await tx.query<QueryResultRow>({
        name: "quota_retry_choice_lock_v1",
        text: `SELECT q.*,${CURRENT_SQL} AS current
        FROM data.agent_quota_retries q WHERE q.space_id=$4 AND q.channel_id=$1 AND q.retry_id=$2 AND q.actor_user_id=$3 FOR UPDATE OF q`,
        values: [input.channelId, input.id, input.actorUserId, this.placement.spaceId],
        maxRows: 1,
      });
      if (!row) throw new RegistrationAccessError("quota_retry_not_found", 404);
      if (input.action === "wait" && ["waiting", "dispatching", "dispatched"].includes(String(row.state))) return;
      if (input.action === "wait" && (row.current !== true || Date.parse(String(row.expires_at)) <= Date.now()))
        throw new RegistrationAccessError("quota_retry_expired", 409);
      if (row.state === "dispatched") throw new RegistrationAccessError("quota_retry_already_started", 409);
      if (input.action === "wait" && row.state !== "offered" && row.state !== "waiting")
        throw new RegistrationAccessError("quota_retry_cancelled", 409);
      await tx.query({
        name: "quota_retry_choice_v2",
        text: `UPDATE data.agent_quota_retries SET state=$4,verify_until=NULL,
        next_check_at=CASE WHEN $4='waiting' THEN COALESCE(next_check_at,clock_timestamp()) END,updated_at=clock_timestamp()
        WHERE channel_id=$1 AND retry_id=$2 AND actor_user_id=$3`,
        values: [input.channelId, input.id, input.actorUserId, input.action === "wait" ? "waiting" : "cancelled"],
        maxRows: 0,
      });
    });
  }
  /** A provider reading may have cleared this Channel's refused summons:
   * every retry still waiting or verifying is due now. Only the due time
   * moves; its state, generation and admission are untouched, and the full
   * launch admission decides. Returns how many became due. */
  async wake(channelId: string): Promise<number> {
    const rows = await this.database.transaction({ requestId: crypto.randomUUID(), operation: "quota-retry.wake",
      placement: this.placement }, tx => tx.query({ name: "quota_retry_wake_v1",
      text: `UPDATE data.agent_quota_retries q SET next_check_at=LEAST(q.next_check_at,clock_timestamp()),
          wake_revision=COALESCE(q.wake_revision,0)+1,updated_at=clock_timestamp()
        WHERE q.space_id=$2 AND q.channel_id=$1 AND ${WAKEABLE_SQL}
        RETURNING q.retry_id`, values: [channelId, this.placement.spaceId], maxRows: 1000 }));
    return rows.length;
  }
  async due(channelId: string): Promise<QuotaRetryWork[]> {
    return this.database.transaction(
      {
        requestId: crypto.randomUUID(),
        operation: "quota-retry.due",
        placement: this.placement,
      },
      async (tx) => {
        await lockChannelLifecycle(tx, {
          channelId,
          capability: "runtime_new_work",
        });
        const rows = await tx.query<
          QuotaRetryWork & {
            current: boolean;
            authorized: boolean;
            verifying: boolean;
          }
        >({
          name: "quota_retry_due_v2",
          text: `SELECT q.*,${CURRENT_SQL} AS current,${VERIFYING_SQL} AS verifying,
        ${channelCapabilityPredicate({ capability: "runtime_new_work", channelAlias: "c", principalKindSql: "'user'", principalIdSql: "q.actor_user_id" })} AS authorized
        FROM data.agent_quota_retries q JOIN data.channels c USING (space_id,channel_id)
        WHERE q.space_id=$2 AND q.channel_id=$1 AND q.next_check_at<=clock_timestamp()
        ORDER BY q.next_check_at,q.retry_id LIMIT 20 FOR UPDATE OF q SKIP LOCKED`,
          values: [channelId, this.placement.spaceId],
          maxRows: 20,
        });
        const ready: QuotaRetryWork[] = [];
        for (const row of rows) {
          const state =
            row.current !== true || row.authorized !== true
              ? "cancelled"
              : Date.parse(String(row.expires_at)) <= Date.now()
                ? "expired"
                : row.state;
          // A verifying summon is worked like a waiting one; it stays offered
          // so its author can still choose, and the card does not claim a wait.
          const worked = state === "waiting" || state === "dispatching" || (state === "offered" && row.verifying === true);
          await tx.query({
            name: "quota_retry_due_settle_v2",
            text: `UPDATE data.agent_quota_retries SET state=$3,
          next_check_at=CASE WHEN $4 THEN clock_timestamp()+interval '1 minute' END,
          updated_at=clock_timestamp() WHERE channel_id=$1 AND retry_id=$2`,
            values: [channelId, row.retry_id, state, worked],
            maxRows: 0,
          });
          if (worked) ready.push(row);
        }
        return ready;
      },
    );
  }
  async dispatch(input: { channelId: string; row: QuotaRetryWork }): Promise<AgentQuotaRetryAdmission> {
    return this.transaction(input.channelId, input.row.actor_user_id, "dispatch", async (tx) => {
      const [row] = await tx.query<QueryResultRow>({
        name: "quota_retry_dispatch_v2",
        text: `UPDATE data.agent_quota_retries q
        SET state='dispatching',updated_at=clock_timestamp() WHERE q.channel_id=$1 AND q.retry_id=$2
          AND (q.state IN ('waiting','dispatching') OR ${VERIFYING_SQL})
          AND q.generation=$3 AND q.expires_at>clock_timestamp() AND ${CURRENT_SQL} RETURNING generation`,
        values: [input.channelId, input.row.retry_id, input.row.generation],
        maxRows: 1,
      });
      if (!row) throw new RegistrationAccessError("quota_retry_cancelled", 409);
      return { id: input.row.retry_id, generation: Number(row.generation) };
    });
  }
  /** `waiting` with no `nextCheck` waits for an event (a reading, a reconnect)
   * rather than a time. A summon still verifying that is not started returns
   * to its offer: only its author's choice makes it wait. */
  async settle(
    channelId: string,
    row: QuotaRetryWork,
    result: "dispatched" | "waiting" | "cancelled" | "failed",
    nextCheck?: number | null,
    errorCode?: string,
    /** A launch refused again for used-up quota rested on this reading:
     * only a newer one starts the retry now. */
    refusedThrough?: string,
  ): Promise<void> {
    await this.database.transaction(
      {
        requestId: crypto.randomUUID(),
        operation: "quota-retry.settle",
        placement: this.placement,
      },
      (tx) =>
        tx.query({
          name: "quota_retry_settle_v2",
          text: `UPDATE data.agent_quota_retries SET
        state=CASE WHEN $4='waiting' AND verify_until IS NOT NULL THEN 'offered' ELSE $4 END,
        generation=generation+CASE WHEN $4='waiting' AND state='dispatching' THEN 1 ELSE 0 END,
        -- A wake since this check read the row stays due: it is news this check never saw.
        next_check_at=CASE WHEN $4='waiting' AND COALESCE(wake_revision,0)<>$7::bigint THEN clock_timestamp()
          ELSE $5::timestamptz END,
        last_error_code=$6,updated_at=clock_timestamp(),
        refused_through=CASE WHEN $8::timestamptz IS NULL THEN refused_through
          ELSE GREATEST(COALESCE(refused_through,$8::timestamptz),$8::timestamptz) END
        WHERE channel_id=$1 AND retry_id=$2 AND generation=$3
          AND (state IN ('waiting','dispatching') OR (state='offered' AND kind='launch' AND verify_until IS NOT NULL))`,
          values: [
            channelId,
            row.retry_id,
            row.generation,
            result,
            result === "waiting" && nextCheck != null ? new Date(nextCheck).toISOString() : null,
            errorCode && /^[a-z][a-z0-9_]{1,119}$/u.test(errorCode) ? errorCode : null,
            String(row.wake_revision ?? 0),
            refusedThrough && Number.isFinite(Date.parse(refusedThrough)) ? new Date(refusedThrough).toISOString() : null,
          ],
          maxRows: 0,
        }),
    );
  }
}
