import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import {
  currentRegistrationQuotaSql,
  lockRegistrationQuotaPools,
  QUOTA_WAITER_RECONCILE_PAGE_SIZE,
  readCurrentRegistrationQuotaPoolObservation,
  reconcileRegistrationQuotaPoolPage,
  recordPoolReconciliationTransition,
  REGISTRATION_QUOTA_POOL_SQL,
  registrationQuotaVerdict,
  type RegistrationQuotaPoolKey,
} from "./agent-registration-quota-probe.js";
import type { RegistrationQuotaKey } from "./registration-quota-state.js";

/** At most this many registrations one refusal waits on, and waits one delivery takes. */
const QUOTA_WAITER_LIMIT = 32;
const RECONCILE_POOLS_PER_PASS = 32;

const requestedRegistrations = (registrations: readonly RegistrationQuotaKey[]) => JSON.stringify(
  registrations.slice(0, QUOTA_WAITER_LIMIT).map(({ ownerUserId, machineId, harness }) => ({ ownerUserId, machineId, harness })));

/**
 * A summon in `channelId` was refused because these registrations' quota read
 * as used up: wait on their pools until `expiresAt` for a reading newer than
 * `refusedThrough`, the reading that refused. Acquires the same per-pool lock
 * order as observation/hold writers so concurrent registration and observation
 * cannot both commit without recording readiness. Only checks the registered
 * pools, never an owner-wide prefix. True when one of these waits is ready.
 */
export async function waitForRegistrationQuota(database: AuthorityDatabase, input: {
  channelId: string; registrations: readonly RegistrationQuotaKey[]; refusedThrough: string; expiresAt: string;
  requestId: string;
}): Promise<boolean> {
  if (!input.registrations.length) return false;
  return database.transaction({ requestId: input.requestId, operation: "registration.quota.wait" }, async tx => {
    const resolved = await tx.query<QueryResultRow>({
      name: "registration_quota_wait_pools_v1",
      text: `SELECT DISTINCT e.owner_user_id,${REGISTRATION_QUOTA_POOL_SQL} AS quota_pool_id
        FROM jsonb_to_recordset($1::jsonb) AS requested("ownerUserId" text,"machineId" text,harness text)
        JOIN control.agent_registration_environments e ON e.owner_user_id=requested."ownerUserId"
          AND e.machine_id=requested."machineId" AND e.harness=requested.harness
        WHERE $2::timestamptz>statement_timestamp()`,
      values: [requestedRegistrations(input.registrations), input.expiresAt],
      maxRows: QUOTA_WAITER_LIMIT,
    });
    if (!resolved.length) return false;
    const pools: RegistrationQuotaPoolKey[] = await lockRegistrationQuotaPools(
      tx,
      resolved.map(row => ({ ownerUserId: String(row.owner_user_id), quotaPoolId: String(row.quota_pool_id) })),
    );
    await tx.query({
      name: "registration_quota_wait_v2",
      text: `INSERT INTO control.registration_quota_waiters
          (owner_user_id,quota_pool_id,channel_id,refused_through,expires_at)
        SELECT p.owner,p.pool,$2,$3::timestamptz,$4::timestamptz
        FROM jsonb_to_recordset($1::jsonb) AS p(owner text,pool text)
        WHERE $4::timestamptz>statement_timestamp()
        ON CONFLICT (owner_user_id,quota_pool_id,channel_id) DO UPDATE SET
          refused_through=LEAST(registration_quota_waiters.refused_through,EXCLUDED.refused_through),
          expires_at=GREATEST(registration_quota_waiters.expires_at,EXCLUDED.expires_at),
          ready_at=NULL,ready_token=NULL`,
      values: [
        JSON.stringify(pools.map(pool => ({ owner: pool.ownerUserId, pool: pool.quotaPoolId }))),
        input.channelId,
        input.refusedThrough,
        input.expiresAt,
      ],
      maxRows: 0,
    });
    let ready = false;
    for (const pool of pools) {
      const obs = await readCurrentRegistrationQuotaPoolObservation(tx, pool.ownerUserId, pool.quotaPoolId);
      if (!obs || registrationQuotaVerdict(obs).state === "usedUp") continue;
      const woken = await tx.query<QueryResultRow>({
        name: "registration_quota_wait_ready_self_v1",
        text: `UPDATE control.registration_quota_waiters
          SET ready_at=clock_timestamp(),ready_token=gen_random_uuid()
          WHERE owner_user_id=$1 AND quota_pool_id=$2 AND channel_id=$3
            AND ready_at IS NULL AND expires_at>statement_timestamp() AND refused_through<$4::timestamptz
          RETURNING channel_id`,
        values: [pool.ownerUserId, pool.quotaPoolId, input.channelId, obs.observed_at],
        maxRows: 1,
      });
      if (woken.length) ready = true;
    }
    return ready;
  });
}

/**
 * Reconcile bounded pages of pools with pending durable reconciliation
 * obligations (`reconcile_needed_revision > reconciled_revision`) as well as
 * legacy unready rows whose pool predates the reconciliation ledger. Reads and
 * writes PostgreSQL only; never contacts a daemon or provider.
 */
export async function reconcileOwedRegistrationQuotaPools(database: AuthorityDatabase, input: {
  ownerUserId?: string; pageSize?: number; maxPools?: number; requestId: string;
}): Promise<{ readied: number; more: boolean }> {
  const maxPools = Math.min(Math.max(Math.trunc(input.maxPools ?? RECONCILE_POOLS_PER_PASS), 1), 64);
  const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? QUOTA_WAITER_RECONCILE_PAGE_SIZE), 1), 256);
  const duePools = await database.transaction(
    { requestId: input.requestId, operation: "registration.quota.reconcile-list", statement: "single_read" },
    tx => tx.query<QueryResultRow>({
      name: "registration_quota_pool_reconcile_due_v1",
      text: `SELECT owner_user_id,quota_pool_id,bool_or(legacy) AS legacy FROM (
          SELECT owner_user_id,quota_pool_id,FALSE AS legacy,updated_at AS since
          FROM control.registration_quota_pool_reconciliations
          WHERE reconcile_needed_revision>reconciled_revision
            AND ($1::text IS NULL OR owner_user_id=$1)
          UNION ALL
          SELECT DISTINCT w.owner_user_id,w.quota_pool_id,TRUE AS legacy,w.refused_through AS since
          FROM control.registration_quota_waiters w
          JOIN control.registration_quota_observations q ON q.owner_user_id=w.owner_user_id
            AND q.quota_pool_id=w.quota_pool_id AND q.observed_at>w.refused_through
            AND ${currentRegistrationQuotaSql("q")}
          LEFT JOIN control.registration_quota_pool_reconciliations r ON r.owner_user_id=w.owner_user_id
            AND r.quota_pool_id=w.quota_pool_id
          WHERE ($1::text IS NULL OR w.owner_user_id=$1)
            AND w.ready_at IS NULL AND w.expires_at>statement_timestamp()
            AND r.owner_user_id IS NULL
        ) due
        GROUP BY owner_user_id,quota_pool_id
        ORDER BY min(since) ASC,owner_user_id,quota_pool_id
        LIMIT $2`,
      values: [input.ownerUserId ?? null, maxPools],
      maxRows: maxPools,
    }),
  );

  let readied = 0;
  let more = duePools.length >= maxPools;
  for (const row of duePools) {
    const ownerUserId = String(row.owner_user_id);
    const quotaPoolId = String(row.quota_pool_id);
    const legacy = row.legacy === true;
    const result = await database.transaction(
      { requestId: input.requestId, operation: "registration.quota.reconcile-pool" },
      async tx => {
        await lockRegistrationQuotaPools(tx, [{ ownerUserId, quotaPoolId }]);
        const obs = await readCurrentRegistrationQuotaPoolObservation(tx, ownerUserId, quotaPoolId);
        if (legacy) {
          const open = obs !== undefined && registrationQuotaVerdict(obs).state !== "usedUp";
          const existing = await tx.query<QueryResultRow>({
            name: "registration_quota_pool_reconcile_exists_v1",
            text: "SELECT 1 FROM control.registration_quota_pool_reconciliations WHERE owner_user_id=$1 AND quota_pool_id=$2 LIMIT 1",
            values: [ownerUserId, quotaPoolId],
            maxRows: 1,
          });
          if (!existing.length) {
            await recordPoolReconciliationTransition(tx, ownerUserId, quotaPoolId, open);
          }
        }
        return reconcileRegistrationQuotaPoolPage(tx, { ownerUserId, quotaPoolId, pageSize, ...(obs ? { observation: obs } : {}) });
      },
    );
    readied += result.readied;
    if (result.more) more = true;
  }
  return { readied, more };
}

/** One ready wait to deliver. `readyToken` is new each time a wait becomes
 * ready, so a delivery settles only the wait it read, never one re-armed or
 * made ready again since. */
export interface ReadyRegistrationQuotaWait { ownerUserId: string; quotaPoolId: string; channelId: string; readyToken: string }

/** The owner's ready waits, oldest first; expired waits are dropped on the way. */
export async function readyRegistrationQuotaWaits(database: AuthorityDatabase, input: {
  ownerUserId: string; requestId: string;
}): Promise<ReadyRegistrationQuotaWait[]> {
  return database.transaction({ requestId: input.requestId, operation: "registration.quota.ready" }, async tx => {
    await tx.query({ name: "registration_quota_waiters_expire_v1", text: `DELETE FROM
        control.registration_quota_waiters WHERE owner_user_id=$1 AND expires_at<=statement_timestamp()`,
    values: [input.ownerUserId], maxRows: 0 });
    const rows = await tx.query<QueryResultRow>({ name: "registration_quota_waiters_ready_read_v1", text: `SELECT
        quota_pool_id,channel_id,ready_token::text AS ready_token FROM control.registration_quota_waiters
      WHERE owner_user_id=$1 AND ready_token IS NOT NULL ORDER BY ready_at,channel_id LIMIT ${QUOTA_WAITER_LIMIT}`,
    values: [input.ownerUserId], maxRows: QUOTA_WAITER_LIMIT });
    return rows.map(row => ({ ownerUserId: input.ownerUserId, quotaPoolId: String(row.quota_pool_id),
      channelId: String(row.channel_id), readyToken: String(row.ready_token) }));
  });
}

/** Delivered waits are done. A wait re-armed or made ready again since it was
 * read keeps its row: its own delivery settles it. */
export async function settleRegistrationQuotaWaits(database: AuthorityDatabase, input: {
  waits: readonly ReadyRegistrationQuotaWait[]; requestId: string;
}): Promise<void> {
  if (!input.waits.length) return;
  await database.transaction({ requestId: input.requestId, operation: "registration.quota.settle" }, tx => tx.query({
    name: "registration_quota_waiters_settle_v1", text: `DELETE FROM control.registration_quota_waiters w
      USING jsonb_to_recordset($1::jsonb) AS done(owner text,pool text,channel text,token uuid)
      WHERE w.owner_user_id=done.owner AND w.quota_pool_id=done.pool AND w.channel_id=done.channel
        AND w.ready_token=done.token`,
    values: [JSON.stringify(input.waits.map(wait => ({ owner: wait.ownerUserId, pool: wait.quotaPoolId,
      channel: wait.channelId, token: wait.readyToken })))], maxRows: 0 }));
}

/** Owners with either a ready wait older than `olderThanMs`, an unacknowledged
 * pool reconciliation obligation, or a legacy unreconciled wait. Reads the
 * database only and never triggers provider requests. */
export async function owedRegistrationQuotaWaitOwners(database: AuthorityDatabase, input: {
  olderThanMs: number; limit: number; requestId: string;
}): Promise<string[]> {
  const rows = await database.transaction({ requestId: input.requestId, operation: "registration.quota.owed",
    statement: "single_read" }, tx => tx.query<QueryResultRow>({ name: "registration_quota_waiters_owed_v2",
    text: `SELECT owner_user_id FROM (
        SELECT owner_user_id,min(since) AS since FROM (
          SELECT owner_user_id,min(ready_at) AS since
          FROM control.registration_quota_waiters
          WHERE ready_at IS NOT NULL AND ready_at<statement_timestamp()-make_interval(secs=>$1::integer/1000.0)
          GROUP BY owner_user_id
          UNION ALL
          SELECT owner_user_id,min(updated_at) AS since
          FROM control.registration_quota_pool_reconciliations
          WHERE reconcile_needed_revision>reconciled_revision
          GROUP BY owner_user_id
          UNION ALL
          SELECT w.owner_user_id,min(w.refused_through) AS since
          FROM control.registration_quota_waiters w
          JOIN control.registration_quota_observations q ON q.owner_user_id=w.owner_user_id
            AND q.quota_pool_id=w.quota_pool_id AND q.observed_at>w.refused_through
            AND ${currentRegistrationQuotaSql("q")}
          LEFT JOIN control.registration_quota_pool_reconciliations r ON r.owner_user_id=w.owner_user_id
            AND r.quota_pool_id=w.quota_pool_id
          WHERE w.ready_at IS NULL AND w.expires_at>statement_timestamp() AND r.owner_user_id IS NULL
          GROUP BY w.owner_user_id
        ) combined
        GROUP BY owner_user_id
      ) owed ORDER BY since ASC,owner_user_id ASC LIMIT $2`,
    values: [input.olderThanMs, input.limit], maxRows: input.limit }));
  return rows.map(row => String(row.owner_user_id));
}

/** The registrations of `ownerUserId` on `machineId` whose pools a summon is
 * waiting on: a reconnected machine reads these again. */
export async function waitedRegistrationsOnMachine(database: AuthorityDatabase, input: {
  ownerUserId: string; machineId: string; requestId: string;
}): Promise<RegistrationQuotaKey[]> {
  const rows = await database.transaction({ requestId: input.requestId, operation: "registration.quota.waited",
    statement: "single_read" }, tx => tx.query<QueryResultRow>({ name: "registration_quota_waited_on_machine_v1",
    text: `SELECT DISTINCT e.harness FROM control.agent_registration_environments e
      JOIN control.registration_quota_waiters w ON w.owner_user_id=e.owner_user_id
        AND w.quota_pool_id=${REGISTRATION_QUOTA_POOL_SQL} AND w.ready_token IS NULL AND w.expires_at>statement_timestamp()
      WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.declaration_json->'enabled'='true'::jsonb
      ORDER BY e.harness LIMIT ${QUOTA_WAITER_LIMIT}`,
    values: [input.ownerUserId, input.machineId], maxRows: QUOTA_WAITER_LIMIT }));
  return rows.map(row => ({ ownerUserId: input.ownerUserId, machineId: input.machineId, harness: String(row.harness) }));
}
