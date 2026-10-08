import { currentRoutingQuotaWindows, parseLlmQuotaAccount, routingQuotaObservation, routingQuotaResetTime,
  type LlmUsage, type RoutingQuotaWindow } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import { REGISTRATION_QUOTA_POOL_SQL,
  upsertRegistrationQuotaObservation } from "./agent-registration-quota-probe.js";

/** Coordinates supplied by an authorized registration/Run read, never by provider metadata. */
export interface RegistrationQuotaKey { ownerUserId: string; machineId: string; harness: string }
export const registrationQuotaKey = (key: RegistrationQuotaKey): string =>
  JSON.stringify([key.ownerUserId, key.machineId, key.harness]);

/** Instance observations and daemon probes share this directory-owned record. */
export async function observeRegistrationQuota(database: AuthorityDatabase, key: RegistrationQuotaKey,
  usage: unknown, requestId: string): Promise<void> {
  const observation = routingQuotaObservation(usage, Date.now());
  if (!observation) return;
  const windows = currentRoutingQuotaWindows(((usage as LlmUsage).quotaUsages ?? []).flatMap(window => {
    if (typeof window.percent !== "number") return [];
    const reset = routingQuotaResetTime(window.resetAt);
    return [{ label: window.label ?? window.window, usedPercent: window.percent,
      ...(Number.isFinite(reset) ? { resetAt: new Date(reset).toISOString() } : {}) }];
  }), Date.now());
  const account = parseLlmQuotaAccount((usage as LlmUsage).quotaAccount);
  await database.transaction({ requestId, operation: "registration.quota.observe-instance" }, async tx => {
    const rows = await tx.query<QueryResultRow>({ name: "registration_quota_instance_pool_v1",
      text: `SELECT ${REGISTRATION_QUOTA_POOL_SQL} AS quota_pool_id FROM control.agent_registration_environments e
        WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=$3`,
      values: [key.ownerUserId, key.machineId, key.harness], maxRows: 1 });
    if (!rows[0]) return;
    await upsertRegistrationQuotaObservation(tx, { ownerUserId: key.ownerUserId,
      quotaPoolId: String(rows[0].quota_pool_id), remaining: observation.value,
      observedAt: observation.observedAt, expiresAt: observation.expiresAt, source: "provider", windows,
      ...(account ? { account } : {}) });
  });
}

/** Batch reads for already authorized presentation consumers. Unknown/expired readings stay unknown. */
export async function readRegistrationQuotaState(database: AuthorityDatabase,
  keys: readonly RegistrationQuotaKey[], requestId: string): Promise<Map<string, LlmUsage>> {
  const unique = [...new Map(keys.map(key => [registrationQuotaKey(key), key])).values()];
  if (unique.length > 512) throw new Error("Registration quota selector limit exceeded");
  if (!unique.length) return new Map();
  const rows = await database.transaction({ requestId, operation: "registration.quota.read" }, tx =>
    tx.query<QueryResultRow>({ name: "registration_quota_state_v3", text: `SELECT e.owner_user_id,e.machine_id,e.harness,
        quota.source,quota.remaining,quota.observed_at,quota.expires_at,quota.windows_json,quota.account_json FROM jsonb_to_recordset($1::jsonb)
        requested("ownerUserId" text,"machineId" text,harness text)
      JOIN control.agent_registration_environments e ON e.owner_user_id=requested."ownerUserId"
        AND e.machine_id=requested."machineId" AND e.harness=requested.harness
      LEFT JOIN control.registration_quota_observations quota ON quota.owner_user_id=e.owner_user_id
        AND quota.quota_pool_id=${REGISTRATION_QUOTA_POOL_SQL}`,
      values: [JSON.stringify(unique)], maxRows: 512 }));
  const result = new Map<string, LlmUsage>();
  for (const row of rows) {
    const key = registrationQuotaKey({ ownerUserId: String(row.owner_user_id), machineId: String(row.machine_id), harness: String(row.harness) });
    const observed = row.observed_at ? new Date(row.observed_at as string).getTime() : NaN;
    const expires = row.expires_at ? new Date(row.expires_at as string).getTime() : NaN;
    if (!Number.isFinite(observed) || observed > Date.now() || !Number.isFinite(expires) || expires <= Date.now()) {
      result.set(key, { quotaState: "unknown", ...(Number.isFinite(observed) && observed <= Date.now()
        ? { quotaObservedAt: new Date(observed).toISOString() } : {}) });
      continue;
    }
    const windows: RoutingQuotaWindow[] = currentRoutingQuotaWindows(row.windows_json, Date.now());
    // Usage-limit holds are authoritative too, even when the provider gave no named window.
    const quotaUsages = windows.length ? windows.map(({ label, usedPercent, resetAt }) =>
      ({ ...(label ? { label } : {}), percent: usedPercent, ...(resetAt ? { resetAt } : {}) }))
      : [{ percent: 100 - Number(row.remaining) }];
    const quotaAccount = parseLlmQuotaAccount(row.account_json);
    result.set(key, {
      quotaState: (row.source === "daemon" || !windows.length) && Number(row.remaining) <= 0 ? "exhausted" : "observed",
      quotaSource: "provider_api", quotaObservedAt: new Date(row.observed_at as string).toISOString(), quotaUsages,
      ...(quotaAccount ? { quotaAccount } : {}),
    });
  }
  return result;
}
