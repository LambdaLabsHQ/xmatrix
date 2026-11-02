import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import { markRegistrationQuotaWaitersReady, REGISTRATION_QUOTA_POOL_SQL } from "./agent-registration-quota-probe.js";
import type { RegistrationQuotaKey } from "./registration-quota-state.js";

/** At most this many registrations one refusal waits on, and waits one delivery takes. */
const QUOTA_WAITER_LIMIT = 32;

const requestedRegistrations = (registrations: readonly RegistrationQuotaKey[]) => JSON.stringify(
  registrations.slice(0, QUOTA_WAITER_LIMIT).map(({ ownerUserId, machineId, harness }) => ({ ownerUserId, machineId, harness })));

/**
 * A summon in `channelId` was refused because these registrations' quota read
 * as used up: wait on their pools until `expiresAt` for a reading newer than
 * `refusedThrough`, the reading that refused. The same transaction looks at
 * each pool's current reading, so one that landed between the refusal and
 * this wait marks it ready at once. A new refusal re-arms a wait: whether it
 * is ready is decided afresh. True when one of the owners' waits is ready.
 */
export async function waitForRegistrationQuota(database: AuthorityDatabase, input: {
  channelId: string; registrations: readonly RegistrationQuotaKey[]; refusedThrough: string; expiresAt: string;
  requestId: string;
}): Promise<boolean> {
  if (!input.registrations.length) return false;
  return database.transaction({ requestId: input.requestId, operation: "registration.quota.wait" }, async tx => {
    await tx.query({ name: "registration_quota_wait_v1", text: `INSERT INTO control.registration_quota_waiters
        (owner_user_id,quota_pool_id,channel_id,refused_through,expires_at)
      SELECT DISTINCT e.owner_user_id,${REGISTRATION_QUOTA_POOL_SQL},$2,$3::timestamptz,$4::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS requested("ownerUserId" text,"machineId" text,harness text)
      JOIN control.agent_registration_environments e ON e.owner_user_id=requested."ownerUserId"
        AND e.machine_id=requested."machineId" AND e.harness=requested.harness
      WHERE $4::timestamptz>statement_timestamp()
      ON CONFLICT (owner_user_id,quota_pool_id,channel_id) DO UPDATE SET
        refused_through=LEAST(registration_quota_waiters.refused_through,EXCLUDED.refused_through),
        expires_at=GREATEST(registration_quota_waiters.expires_at,EXCLUDED.expires_at),
        ready_at=NULL,ready_token=NULL`,
    values: [requestedRegistrations(input.registrations), input.channelId, input.refusedThrough, input.expiresAt],
    maxRows: 0 });
    let ready = false;
    for (const owner of new Set(input.registrations.map(key => key.ownerUserId))) {
      ready = await markRegistrationQuotaWaitersReady(tx, owner) || ready;
    }
    return ready;
  });
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

/** Owners with a wait that became ready more than `olderThanMs` ago and is
 * still not delivered: the delivery that should have followed the reading
 * failed, so it is delivered again. Reads the database only. */
export async function owedRegistrationQuotaWaitOwners(database: AuthorityDatabase, input: {
  olderThanMs: number; limit: number; requestId: string;
}): Promise<string[]> {
  const rows = await database.transaction({ requestId: input.requestId, operation: "registration.quota.owed",
    statement: "single_read" }, tx => tx.query<QueryResultRow>({ name: "registration_quota_waiters_owed_v1",
    text: `SELECT owner_user_id FROM (SELECT owner_user_id,min(ready_at) AS since
        FROM control.registration_quota_waiters
        WHERE ready_at IS NOT NULL AND ready_at<statement_timestamp()-make_interval(secs=>$1::integer/1000.0)
        GROUP BY owner_user_id) owed ORDER BY since LIMIT $2`,
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
