import { currentRoutingQuotaWindows, fromPreScopeCursorWire, routingQuotaRecord, routingQuotaUsageWindows,
  type LlmUsage } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import { REGISTRATION_QUOTA_POOL_SQL, registrationQuotaColumns, registrationQuotaUsage,
  upsertRegistrationQuotaObservation, type RegistrationQuotaUsage } from "./agent-registration-quota-probe.js";

/** Coordinates supplied by an authorized registration/Run read, never by provider metadata. */
export interface RegistrationQuotaKey { ownerUserId: string; machineId: string; harness: string }
export const registrationQuotaKey = (key: RegistrationQuotaKey): string =>
  JSON.stringify([key.ownerUserId, key.machineId, key.harness]);

/** Instance observations and daemon probes share this directory-owned record.
 * True when the reading left one of the owner's refused summons ready to wake. */
export async function observeRegistrationQuota(database: AuthorityDatabase, key: RegistrationQuotaKey,
  usage: unknown, requestId: string): Promise<boolean> {
  const record = routingQuotaRecord(fromPreScopeCursorWire(usage, key.harness), Date.now());
  if (!record) return false;
  return database.transaction({ requestId, operation: "registration.quota.observe-instance" }, async tx => {
    const rows = await tx.query<QueryResultRow>({ name: "registration_quota_instance_pool_v1",
      text: `SELECT ${REGISTRATION_QUOTA_POOL_SQL} AS quota_pool_id FROM control.agent_registration_environments e
        WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=$3`,
      values: [key.ownerUserId, key.machineId, key.harness], maxRows: 1 });
    if (!rows[0]) return false;
    return upsertRegistrationQuotaObservation(tx, { ownerUserId: key.ownerUserId,
      quotaPoolId: String(rows[0].quota_pool_id), record });
  });
}

/** A registration and its pool's reading, as both readers select them. */
const REGISTRATION_QUOTA_STATE_COLUMNS = `e.owner_user_id,e.machine_id,e.harness,${registrationQuotaColumns("quota")}`;
const REGISTRATION_QUOTA_STATE_JOIN = `LEFT JOIN control.registration_quota_observations quota
        ON quota.owner_user_id=e.owner_user_id AND quota.quota_pool_id=${REGISTRATION_QUOTA_POOL_SQL}`;

export interface RegistrationQuotaReading { registration: RegistrationQuotaKey; usage: LlmUsage }

async function readRegistrationQuotaRows(database: AuthorityDatabase, keys: readonly RegistrationQuotaKey[],
  requestId: string): Promise<readonly QueryResultRow[]> {
  const unique = [...new Map(keys.map(key => [registrationQuotaKey(key), key])).values()];
  if (unique.length > 512) throw new Error("Registration quota selector limit exceeded");
  if (!unique.length) return [];
  return database.transaction({ requestId, operation: "registration.quota.read", statement: "single_read" }, tx =>
    tx.query<QueryResultRow>({ name: "registration_quota_state_v5", text: `SELECT ${REGISTRATION_QUOTA_STATE_COLUMNS}
      FROM jsonb_to_recordset($1::jsonb) requested("ownerUserId" text,"machineId" text,harness text)
      JOIN control.agent_registration_environments e ON e.owner_user_id=requested."ownerUserId"
        AND e.machine_id=requested."machineId" AND e.harness=requested.harness
      ${REGISTRATION_QUOTA_STATE_JOIN}`,
      values: [JSON.stringify(unique.map(({ ownerUserId, machineId, harness }) => ({ ownerUserId, machineId, harness })))],
      maxRows: 512 }));
}

const rowKey = (row: QueryResultRow): RegistrationQuotaKey => ({ ownerUserId: String(row.owner_user_id),
  machineId: String(row.machine_id), harness: String(row.harness) });

/** Batch reads for already authorized presentation consumers. Unknown/expired readings stay unknown. */
export async function readRegistrationQuotaState(database: AuthorityDatabase,
  keys: readonly RegistrationQuotaKey[], requestId: string): Promise<Map<string, LlmUsage>> {
  return new Map((await readRegistrationQuotaRows(database, keys, requestId)).map(presentedQuotaReading)
    .map((reading): [string, LlmUsage] => [registrationQuotaKey(reading.registration), reading.usage]));
}

/** The current pool readings of these registrations, in the form a model's
 * headroom is read from (`routingQuotaObservation`). Absent when none counts. */
export async function readRegistrationQuotaUsages(database: AuthorityDatabase,
  keys: readonly RegistrationQuotaKey[], requestId: string): Promise<Map<string, RegistrationQuotaUsage>> {
  const now = Date.now();
  return new Map((await readRegistrationQuotaRows(database, keys, requestId)).flatMap(row => {
    const usage = registrationQuotaUsage(row, now);
    return usage ? [[registrationQuotaKey(rowKey(row)), usage] as const] : [];
  }));
}

/**
 * Every registration of one owner with its pool's reading. A probe of one
 * machine can move the reading of a pool its other machines share, so the
 * owner's Agents are refreshed from this one read.
 */
export async function readOwnerRegistrationQuotaState(database: AuthorityDatabase, ownerUserId: string,
  requestId: string): Promise<RegistrationQuotaReading[]> {
  const rows = await database.transaction({ requestId, operation: "registration.quota.read-owner", statement: "single_read" }, tx =>
    tx.query<QueryResultRow>({ name: "registration_quota_owner_state_v2", text: `SELECT ${REGISTRATION_QUOTA_STATE_COLUMNS}
      FROM control.agent_registration_environments e ${REGISTRATION_QUOTA_STATE_JOIN}
      WHERE e.owner_user_id=$1`, values: [ownerUserId], maxRows: 512 }));
  return rows.map(presentedQuotaReading);
}

/** A pool reading as an Instance shows it: its windows (a usage-limit hold
 * keeps the windows read before it, or shows one used-up window), and whether
 * the account is used up. */
function presentedQuotaReading(row: QueryResultRow): RegistrationQuotaReading {
  const registration = rowKey(row);
  const now = Date.now();
  const usage = registrationQuotaUsage(row, now);
  if (!usage) {
    const observed = row.observed_at ? new Date(row.observed_at as string).getTime() : NaN;
    return { registration, usage: { quotaState: "unknown", ...(Number.isFinite(observed) && observed <= now
      ? { quotaObservedAt: new Date(observed).toISOString() } : {}) } };
  }
  const hold = row.source === "daemon" && new Date(row.expires_at as string).getTime() > now;
  const shown = hold ? routingQuotaUsageWindows(currentRoutingQuotaWindows(row.windows_json, now)) : [];
  const quotaUsages = shown.length ? shown : usage.quotaUsages ?? [];
  const { scopedQuotaObservedAt: _scopedAt, scopedQuotaUsages, ...presented } = usage;
  const cleanScoped = scopedQuotaUsages?.map(({ billingRefusal: _billingRefusal, ...window }) => window);
  return { registration, usage: { ...presented, quotaUsages, ...(cleanScoped ? { scopedQuotaUsages: cleanScoped } : {}),
    quotaState: hold ? "exhausted" : "observed" } };
}
