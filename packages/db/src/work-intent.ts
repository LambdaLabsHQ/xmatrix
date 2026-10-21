import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";

/**
 * Prototype of the durable work protocol (docs/architecture/durable-background-work.md).
 * PostgreSQL holds the only state; a queue message is a hint naming an intent.
 * Every transition is one statement. Nothing in production uses this yet, and
 * its tables are created by tests, not by a migration.
 */

export interface WorkIdentity { scope: string; kind: string; key: string }

/** What a message carries: references only, never the authority. */
export interface WorkDispatch extends WorkIdentity {
  incarnation: string;
  version: number;
  placementEpoch: number | null;
  dispatchToken: string;
  /** When the message should be delivered. */
  wakeAt: Date;
}

export interface WorkExecution extends WorkIdentity {
  incarnation: string;
  executionToken: string;
  version: number;
  plannedAt: Date | null;
  /** A previous attempt's outcome is unknown: the handler reconciles before acting. */
  needsReconcile: boolean;
}

export type WorkPlan =
  | { op: "set"; at: Date }
  | { op: "advance"; at: Date }
  | { op: "postpone"; at: Date }
  | { op: "cancel" };

/**
 * What an execution reports. `reconciled` says it settled an earlier unknown
 * outcome; until one does, that evidence is kept whatever else happens.
 */
export type WorkOutcome = { reconciled?: boolean } & (
  | { kind: "done" }
  | { kind: "defer"; at: Date }
  | { kind: "continue" }
  | { kind: "retry"; notBefore: Date; errorCode: string }
  /** `reconcileAt` asks for a reconcile run then; without it the intent is parked for a person. */
  | { kind: "uncertain"; errorCode: string; reconcileAt?: Date }
  | { kind: "permanent"; errorCode: string });

/** How a kind recovers an execution whose outcome is unknown. */
export type WorkEffects = "safe" | "reconcile" | "at_most_once";

export type WorkStartRefusal = "stale" | "not_due" | "quota";

/** Columns that make a dispatch, read from the row aliased `i`. */
const DISPATCH_COLUMNS = `i.scope,i.kind,i.key,i.incarnation::text AS incarnation,i.version,i.placement_epoch,
  i.dispatch_token::text AS dispatch_token,greatest(i.pending_at,coalesce(i.not_before,i.pending_at)) AS wake_at`;

/** The time an intent may next start, on the server's clock. */
const STARTABLE_AT = "greatest(i.pending_at,coalesce(i.not_before,i.pending_at))";

function dispatchOf(row: QueryResultRow): WorkDispatch {
  return {
    scope: String(row.scope), kind: String(row.kind), key: String(row.key),
    incarnation: String(row.incarnation), version: Number(row.version),
    placementEpoch: row.placement_epoch === null ? null : Number(row.placement_epoch),
    dispatchToken: String(row.dispatch_token), wakeAt: new Date(row.wake_at),
  };
}

/**
 * A Space scope must carry an epoch that is active on this shard; a missing
 * placement fails closed. Only a system scope has no epoch.
 */
function placementCurrent(shardParameter: number): string {
  return `CASE WHEN i.scope LIKE 'space:%' THEN i.placement_epoch IS NOT NULL AND EXISTS (
      SELECT 1 FROM control.space_placement p WHERE p.space_id=substring(i.scope FROM 7) AND p.state='active'
        AND p.target_shard_id IS NULL AND p.shard_id=$${shardParameter} AND p.placement_epoch=i.placement_epoch)
    ELSE i.placement_epoch IS NULL END`;
}

function requirePlacement(identity: WorkIdentity, placementEpoch: number | null): void {
  const space = identity.scope.startsWith("space:");
  if (space !== (placementEpoch !== null)) {
    throw new Error(space ? "A Space intent needs its placement epoch" : "Only a Space intent has a placement epoch");
  }
}

/**
 * Changes the business plan inside the business transaction. Every change
 * increments the version. A change that leaves a pending plan on an idle
 * intent mints a dispatch token and returns the message to send after commit;
 * a change during an execution is picked up by that execution's finish. The
 * recovery time starts at the plan: an intent whose message is never marked
 * sent is found by the reconciler once due.
 */
export async function scheduleWork(tx: DatabaseTransaction, identity: WorkIdentity, plan: WorkPlan,
  placementEpoch: number | null = null): Promise<WorkDispatch | null> {
  requirePlacement(identity, placementEpoch);
  const values = [identity.scope, identity.kind, identity.key];
  if (plan.op === "cancel") {
    // An idle intent with no unsettled outcome goes at once. Anything else is
    // marked: a running one is settled by its finish, and an unknown outcome
    // keeps its evidence until it is reconciled.
    await tx.query({ name: "work_intent_cancel_idle_v1", text: `DELETE FROM data.work_intents i
      WHERE i.scope=$1 AND i.kind=$2 AND i.key=$3 AND i.state<>'started' AND NOT i.needs_reconcile`,
    values, maxRows: 0 });
    await tx.query({ name: "work_intent_cancel_marked_v1", text: `UPDATE data.work_intents i
      SET cancelled=true,state=CASE WHEN i.state='started' THEN 'started' ELSE 'parked' END,
        pending_at=NULL,planned_at=NULL,version=i.version+1,dispatch_token=NULL,recover_at=NULL,updated_at=now()
      WHERE i.scope=$1 AND i.kind=$2 AND i.key=$3`, values, maxRows: 0 });
    return null;
  }
  const merged = plan.op === "set" ? "$4::timestamptz"
    : plan.op === "advance" ? "least(coalesce(i.pending_at,$4::timestamptz),$4::timestamptz)"
      : "CASE WHEN i.pending_at IS NULL THEN NULL ELSE greatest(i.pending_at,$4::timestamptz) END";
  const inserted = plan.op === "postpone" ? "NULL::timestamptz" : "$4::timestamptz";
  await tx.query({ name: "work_scope_quota_ensure_v1", text: `INSERT INTO data.work_scope_quota(scope)
    VALUES ($1) ON CONFLICT (scope) DO NOTHING`, values: [identity.scope], maxRows: 0 });
  const rows = await tx.query<QueryResultRow & { state: string }>({ name: `work_intent_${plan.op}_v1`,
    text: `INSERT INTO data.work_intents AS i (scope,kind,key,incarnation,placement_epoch,state,pending_at,
        planned_at,dispatch_token,recover_at)
      VALUES ($1,$2,$3,gen_random_uuid(),$5,'pending',${inserted},${inserted},
        CASE WHEN ${inserted} IS NULL THEN NULL ELSE gen_random_uuid() END,${inserted})
      ON CONFLICT (scope,kind,key) DO UPDATE SET
        version=i.version+1,
        cancelled=false,
        state=CASE WHEN i.state='parked' THEN 'pending' ELSE i.state END,
        pending_at=${merged},
        planned_at=CASE WHEN ${merged} IS NULL THEN NULL
          WHEN $6 THEN least(coalesce(i.planned_at,${merged}),${merged}) ELSE ${merged} END,
        not_before=NULL,
        dispatch_token=CASE WHEN ${merged} IS NULL THEN NULL ELSE gen_random_uuid() END,
        sent_at=NULL,
        recover_at=${merged},
        updated_at=now()
      WHERE i.placement_epoch IS NOT DISTINCT FROM $5::bigint
      RETURNING i.state,${DISPATCH_COLUMNS}`,
    values: [...values, plan.at.toISOString(), placementEpoch, plan.op === "advance"], maxRows: 1 });
  const row = rows[0];
  return row && row.state === "pending" && row.dispatch_token !== null ? dispatchOf(row) : null;
}

/**
 * Records that a message was sent. The reconciler looks at the intent again
 * only after the later of its wake time and now, plus the cooldown.
 */
export async function markWorkSent(tx: DatabaseTransaction, dispatch: WorkDispatch, cooldownMs: number):
  Promise<void> {
  await tx.query({ name: "work_intent_sent_v1", text: `UPDATE data.work_intents i SET sent_at=clock_timestamp(),
      recover_at=greatest(${STARTABLE_AT},clock_timestamp())+$5*interval '1 millisecond'
    WHERE i.scope=$1 AND i.kind=$2 AND i.key=$3 AND i.dispatch_token=$4::uuid AND i.state='pending'`,
  values: [dispatch.scope, dispatch.kind, dispatch.key, dispatch.dispatchToken, cooldownMs], maxRows: 0 });
}

/**
 * One compare-and-set from pending to started. A duplicated, late or
 * superseded message matches no row. The scope's quota row is taken in the
 * same statement, so a refused start holds no slot.
 */
export async function startWork(tx: DatabaseTransaction, dispatch: WorkDispatch,
  options: { leaseMs: number; scopeLimit: number; shardId: string }):
  Promise<WorkExecution | WorkStartRefusal> {
  const identity = [dispatch.scope, dispatch.kind, dispatch.key, dispatch.incarnation, dispatch.dispatchToken];
  const rows = await tx.query<QueryResultRow>({ name: "work_intent_start_v1", text: `WITH candidate AS (
      SELECT i.scope,i.kind,i.key FROM data.work_intents i
      WHERE i.scope=$1 AND i.kind=$2 AND i.key=$3 AND i.incarnation=$4::uuid AND i.dispatch_token=$5::uuid
        AND i.state='pending' AND NOT i.cancelled AND i.pending_at IS NOT NULL
        AND ${STARTABLE_AT}<=statement_timestamp()
        AND i.placement_epoch IS NOT DISTINCT FROM $6::bigint AND ${placementCurrent(9)}
      FOR UPDATE),
    slot AS (UPDATE data.work_scope_quota q SET inflight=q.inflight+1
      WHERE q.scope=$1 AND q.inflight<$7 AND EXISTS (SELECT 1 FROM candidate) RETURNING q.scope)
    UPDATE data.work_intents i SET state='started',execution_token=gen_random_uuid(),started_version=i.version,
      running_plan_at=i.pending_at,pending_at=NULL,dispatch_token=NULL,recover_at=NULL,
      lease_until=clock_timestamp()+$8*interval '1 millisecond',
      business_attempts=i.business_attempts+1,updated_at=now()
    FROM candidate WHERE (i.scope,i.kind,i.key)=(candidate.scope,candidate.kind,candidate.key)
      AND EXISTS (SELECT 1 FROM slot)
    RETURNING i.scope,i.kind,i.key,i.incarnation::text AS incarnation,i.execution_token::text AS execution_token,
      i.version,i.planned_at,i.needs_reconcile`,
  values: [...identity, dispatch.placementEpoch, options.scopeLimit, options.leaseMs, options.shardId], maxRows: 1 });
  const row = rows[0];
  if (row) {
    return { scope: String(row.scope), kind: String(row.kind), key: String(row.key),
      incarnation: String(row.incarnation), executionToken: String(row.execution_token),
      version: Number(row.version), plannedAt: row.planned_at ? new Date(row.planned_at) : null,
      needsReconcile: row.needs_reconcile === true };
  }
  // Why it did not start decides what the consumer does with the message. A
  // refusal is counted apart from business attempts.
  const refused = await tx.query<QueryResultRow & { not_due: boolean }>({ name: "work_intent_start_refusal_v1",
    text: `UPDATE data.work_intents i SET refusals=i.refusals+CASE WHEN ${STARTABLE_AT}>statement_timestamp()
        THEN 0 ELSE 1 END
      WHERE i.scope=$1 AND i.kind=$2 AND i.key=$3 AND i.incarnation=$4::uuid AND i.dispatch_token=$5::uuid
        AND i.state='pending' AND NOT i.cancelled AND i.placement_epoch IS NOT DISTINCT FROM $6::bigint
        AND ${placementCurrent(7)}
      RETURNING ${STARTABLE_AT}>statement_timestamp() AS not_due`,
  values: [...identity, dispatch.placementEpoch, options.shardId], maxRows: 1 });
  if (!refused[0]) return "stale";
  return refused[0].not_due ? "not_due" : "quota";
}

/**
 * Settles an execution. The row is locked first; only then are the lease and
 * placement checked against the server's actual time, so a finish that waited
 * for the lock past its lease settles nothing.
 *
 * If the business changed the plan meanwhile, the old execution settles only
 * its own attempt: the new plan stays runnable whatever the old outcome was,
 * and an unknown outcome only adds evidence. Unsettled evidence is never
 * deleted: the intent is kept, parked if nothing else is pending.
 */
export async function finishWork(tx: DatabaseTransaction, execution: WorkExecution, outcome: WorkOutcome,
  options: { shardId: string }): Promise<{ settled: boolean; next: WorkDispatch | null }> {
  const reconcileLater = "($6='uncertain' AND $13::timestamptz IS NOT NULL)";
  const removes = "NOT current.evidence AND (current.cancelled OR (NOT current.changed AND $6='done'))";
  const state = `CASE WHEN current.cancelled THEN 'parked'
    WHEN current.changed THEN CASE WHEN i.pending_at IS NULL AND current.evidence THEN 'parked' ELSE 'pending' END
    WHEN $6 IN ('permanent','done') OR ($6='uncertain' AND NOT ${reconcileLater}) THEN 'parked'
    ELSE 'pending' END`;
  const pending = `CASE WHEN current.cancelled THEN NULL WHEN current.changed THEN i.pending_at
    WHEN $6='defer' THEN $7::timestamptz WHEN $6='continue' THEN statement_timestamp()
    WHEN $6='retry' OR ${reconcileLater} THEN current.running_plan_at END`;
  const notBefore = `CASE WHEN current.cancelled OR current.changed THEN NULL
    WHEN $6='retry' THEN $8::timestamptz WHEN ${reconcileLater} THEN $13::timestamptz END`;
  const rows = await tx.query<QueryResultRow & { result: string; state: string | null }>({ name: "work_intent_finish_v1",
    text: `WITH locked AS MATERIALIZED (
      SELECT i.scope,i.kind,i.key FROM data.work_intents i
      WHERE i.scope=$1 AND i.kind=$2 AND i.key=$3 AND i.incarnation=$4::uuid AND i.execution_token=$5::uuid
        AND i.state='started'
      FOR UPDATE),
    current AS MATERIALIZED (
      SELECT i.scope,i.kind,i.key,i.version<>i.started_version AS changed,i.cancelled,i.running_plan_at,
        (i.needs_reconcile AND NOT $11::boolean) OR $12::boolean AS evidence
      FROM data.work_intents i JOIN locked USING (scope,kind,key)
      WHERE i.lease_until>clock_timestamp() AND ${placementCurrent(10)}),
    slot AS (UPDATE data.work_scope_quota q SET inflight=greatest(q.inflight-1,0)
      FROM current WHERE q.scope=current.scope RETURNING q.scope),
    removed AS (DELETE FROM data.work_intents i USING current
      WHERE (i.scope,i.kind,i.key)=(current.scope,current.kind,current.key) AND ${removes}
      RETURNING i.scope),
    updated AS (UPDATE data.work_intents i SET
      state=${state},
      needs_reconcile=current.evidence,
      pending_at=${pending},
      planned_at=CASE WHEN current.cancelled THEN NULL WHEN current.changed THEN i.planned_at
        WHEN $6='defer' THEN $7::timestamptz WHEN $6 IN ('retry','continue','uncertain') THEN i.planned_at END,
      not_before=${notBefore},
      dispatch_token=CASE WHEN current.cancelled THEN NULL WHEN current.changed THEN i.dispatch_token
        WHEN $6 IN ('defer','continue','retry') OR ${reconcileLater} THEN gen_random_uuid() END,
      recover_at=CASE WHEN (${state})='pending'
        THEN greatest(${pending},coalesce(${notBefore},${pending})) END,
      sent_at=NULL,execution_token=NULL,started_version=NULL,running_plan_at=NULL,lease_until=NULL,
      unknown_outcomes=i.unknown_outcomes+CASE WHEN $12::boolean THEN 1 ELSE 0 END,
      last_outcome=$6,last_error_code=$9,updated_at=now()
    FROM current WHERE (i.scope,i.kind,i.key)=(current.scope,current.kind,current.key) AND NOT (${removes})
    RETURNING i.state,${DISPATCH_COLUMNS})
    SELECT 'removed' AS result,NULL AS state,NULL AS scope,NULL AS kind,NULL AS key,NULL AS incarnation,
      NULL::bigint AS version,NULL::bigint AS placement_epoch,NULL AS dispatch_token,NULL::timestamptz AS wake_at
    FROM removed
    UNION ALL SELECT 'updated',state,scope,kind,key,incarnation,version,placement_epoch,dispatch_token,wake_at
    FROM updated`,
    values: [execution.scope, execution.kind, execution.key, execution.incarnation, execution.executionToken,
      outcome.kind,
      outcome.kind === "defer" ? outcome.at.toISOString() : null,
      outcome.kind === "retry" ? outcome.notBefore.toISOString() : null,
      "errorCode" in outcome ? outcome.errorCode : null, options.shardId,
      outcome.reconciled === true, outcome.kind === "uncertain",
      outcome.kind === "uncertain" && outcome.reconcileAt ? outcome.reconcileAt.toISOString() : null],
    maxRows: 1 });
  const row = rows[0];
  if (!row) return { settled: false, next: null };
  return { settled: true,
    next: row.result === "updated" && row.state === "pending" && row.dispatch_token !== null ? dispatchOf(row) : null };
}

/**
 * A wake further away than the queue's maximum delay is relayed: on early
 * arrival the old token is replaced by compare-and-set, so only one relay wins.
 */
export async function relayWork(tx: DatabaseTransaction, dispatch: WorkDispatch,
  options: { horizonMs: number; cooldownMs: number }): Promise<WorkDispatch | null> {
  const rows = await tx.query<QueryResultRow>({ name: "work_intent_relay_v1", text: `UPDATE data.work_intents i
    SET dispatch_token=gen_random_uuid(),sent_at=clock_timestamp(),
      recover_at=${STARTABLE_AT}+$7*interval '1 millisecond',updated_at=now()
    WHERE i.scope=$1 AND i.kind=$2 AND i.key=$3 AND i.incarnation=$4::uuid AND i.dispatch_token=$5::uuid
      AND i.state='pending' AND NOT i.cancelled
      AND ${STARTABLE_AT}>clock_timestamp()+$6*interval '1 millisecond'
    RETURNING ${DISPATCH_COLUMNS}`,
  values: [dispatch.scope, dispatch.kind, dispatch.key, dispatch.incarnation, dispatch.dispatchToken,
    options.horizonMs, options.cooldownMs], maxRows: 1 });
  return rows[0] ? dispatchOf(rows[0]) : null;
}

/**
 * Pending intents whose recovery time has passed: their message was never
 * marked sent, or was sent at least a cooldown ago and has not started. The
 * same dispatch token is sent again, so a slow queue never invalidates the
 * messages waiting in it. The recovery-time index finds exactly these rows, in
 * the order they became due, however many intents wait for the future; a
 * re-sent row moves a cooldown later, so a backlog cannot starve later rows.
 */
export async function reconcileUnsentWork(tx: DatabaseTransaction, options: { cooldownMs: number; limit: number }):
  Promise<WorkDispatch[]> {
  const rows = await tx.query<QueryResultRow>({ name: "work_intent_reconcile_unsent_v1", text: `UPDATE data.work_intents i
    SET sent_at=clock_timestamp(),recover_at=clock_timestamp()+$1*interval '1 millisecond'
    WHERE (i.scope,i.kind,i.key) IN (SELECT r.scope,r.kind,r.key FROM data.work_intents r
      WHERE r.state='pending' AND NOT r.cancelled AND r.dispatch_token IS NOT NULL
        AND r.recover_at<=statement_timestamp()
      ORDER BY r.recover_at LIMIT $2 FOR UPDATE SKIP LOCKED)
    RETURNING ${DISPATCH_COLUMNS}`, values: [options.cooldownMs, options.limit], maxRows: options.limit });
  return rows.map(dispatchOf);
}

/**
 * Started intents whose lease expired: the outcome is unknown. Each kind's
 * effect contract decides and nothing is replayed blindly. The reconciler
 * records the decision and returns the messages to send; any reconcile step
 * runs in a consumer, never here. Unsettled evidence is never deleted.
 */
export async function reconcileExpiredWork(tx: DatabaseTransaction,
  options: { limit: number; effects: Record<WorkEffects, string[]>; retryAfterMs: number }): Promise<WorkDispatch[]> {
  const safe = "i.kind=ANY($2::text[])", reconcile = "i.kind=ANY($3::text[])";
  const resume = `((${safe} OR ${reconcile}) AND NOT i.cancelled)`;
  const rows = await tx.query<QueryResultRow & { state: string }>({ name: "work_intent_reconcile_expired_v1",
    text: `WITH expired AS (SELECT i.scope,i.kind,i.key FROM data.work_intents i
        WHERE i.state='started' AND i.lease_until<=statement_timestamp()
        ORDER BY i.lease_until LIMIT $1 FOR UPDATE SKIP LOCKED),
      slot AS (UPDATE data.work_scope_quota q SET inflight=greatest(q.inflight-x.n,0)
        FROM (SELECT scope,count(*)::int AS n FROM expired GROUP BY scope) x WHERE q.scope=x.scope RETURNING q.scope),
      removed AS (DELETE FROM data.work_intents i USING expired
        WHERE (i.scope,i.kind,i.key)=(expired.scope,expired.kind,expired.key)
          AND i.cancelled AND ${safe} AND NOT i.needs_reconcile
        RETURNING i.scope)
      UPDATE data.work_intents i SET
        state=CASE WHEN ${resume} THEN 'pending' ELSE 'parked' END,
        needs_reconcile=i.needs_reconcile OR NOT ${safe},
        pending_at=CASE WHEN NOT ${resume} THEN NULL WHEN i.version<>i.started_version THEN i.pending_at
          ELSE i.running_plan_at END,
        not_before=CASE WHEN ${resume} THEN clock_timestamp()+$4*interval '1 millisecond' END,
        dispatch_token=CASE WHEN ${resume} AND (i.version=i.started_version OR i.pending_at IS NOT NULL)
          THEN gen_random_uuid() END,
        recover_at=CASE WHEN ${resume} THEN greatest(CASE WHEN i.version<>i.started_version THEN i.pending_at
          ELSE i.running_plan_at END,clock_timestamp()+$4*interval '1 millisecond') END,
        sent_at=NULL,execution_token=NULL,started_version=NULL,running_plan_at=NULL,lease_until=NULL,
        unknown_outcomes=i.unknown_outcomes+1,last_outcome='expired',updated_at=now()
      FROM expired WHERE (i.scope,i.kind,i.key)=(expired.scope,expired.kind,expired.key)
        AND NOT (i.cancelled AND ${safe} AND NOT i.needs_reconcile)
      RETURNING i.state,${DISPATCH_COLUMNS}`,
    values: [options.limit, options.effects.safe, options.effects.reconcile, options.retryAfterMs],
    maxRows: options.limit });
  return rows.filter(row => row.state === "pending" && row.dispatch_token !== null).map(dispatchOf);
}

/** The prototype's tables, for tests only; a real migration replaces this after the experiments. */
export const WORK_INTENT_PROTOTYPE_SCHEMA = `
CREATE TABLE data.work_intents (
  scope text NOT NULL, kind text NOT NULL, key text NOT NULL,
  incarnation uuid NOT NULL, version bigint NOT NULL DEFAULT 1, placement_epoch bigint,
  state text NOT NULL CHECK (state IN ('pending','started','parked')),
  cancelled boolean NOT NULL DEFAULT false, needs_reconcile boolean NOT NULL DEFAULT false,
  pending_at timestamptz, not_before timestamptz, planned_at timestamptz, running_plan_at timestamptz,
  dispatch_token uuid, sent_at timestamptz, recover_at timestamptz,
  execution_token uuid, started_version bigint, lease_until timestamptz,
  business_attempts integer NOT NULL DEFAULT 0, unknown_outcomes integer NOT NULL DEFAULT 0,
  refusals integer NOT NULL DEFAULT 0, last_outcome text, last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, kind, key),
  CHECK ((scope LIKE 'space:%') = (placement_epoch IS NOT NULL)));
CREATE INDEX work_intents_recovery ON data.work_intents (recover_at)
  WHERE state='pending' AND NOT cancelled AND dispatch_token IS NOT NULL;
CREATE INDEX work_intents_expired ON data.work_intents (lease_until) WHERE state='started';
CREATE TABLE data.work_scope_quota (scope text PRIMARY KEY, inflight integer NOT NULL DEFAULT 0 CHECK (inflight>=0));
`;
