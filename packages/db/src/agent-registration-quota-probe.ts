import { digestCanonicalCloneCborV1, parseLlmQuotaAccount, routingQuotaObservation,
  routingQuotaProbeObservations, type LlmQuotaAccount,
  type RoutingQuotaProbeRequest, type RoutingQuotaWindow } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabasePlacementContext } from "./context.js";

/** A registration target on the machine quota probe wire. Owner and machine are
 * the daemon route the probe is issued to; only the harness travels. */
export const REGISTRATION_QUOTA_PROBE_TARGET_PREFIX = "registration:";

/** The provider account a registered spawn uses is the machine owner's own
 * login for that harness on that machine, so a registration without a declared
 * shared pool is its own pool. Owner scoping comes from the observation row. */
export const REGISTRATION_QUOTA_POOL_SQL =
  `COALESCE(NULLIF(btrim(e.declaration_json->>'quotaPoolId'),''),'registration:'||e.machine_id||':'||e.harness)`;

/** The registration's pool reading while it is current, joined as `alias`
 * beside its environment row `e`. The Agents page and a launch read this one row. */
export function currentRegistrationQuotaJoin(alias: string): string {
  return `LEFT JOIN control.registration_quota_observations ${alias} ON ${alias}.owner_user_id=e.owner_user_id
    AND ${alias}.quota_pool_id=${REGISTRATION_QUOTA_POOL_SQL}
    AND ${alias}.observed_at<=statement_timestamp() AND ${alias}.expires_at>statement_timestamp()`;
}

/** The joined reading as a share of headroom with its times, or none when the
 * row is missing or its share is not between 0 and 100.
 *
 * When `windows_json` is present, headroom is recomputed with
 * `routingQuotaObservation` (Cursor Auto/API: better pool without a model) so a
 * stored `remaining` collapsed by Math.min across pools cannot keep refusing
 * Auto launches; Agents still shows every stored window. */
export function registrationQuotaReading(row: {
  remaining?: unknown; observed_at?: unknown; expires_at?: unknown;
  windows_json?: unknown; account_json?: unknown;
} | undefined):
  { remainingPercent: number; observedAt: string; expiresAt: string } | undefined {
  const observedAt = typeof row?.observed_at === "string" ? row.observed_at : undefined;
  if (observedAt && row?.windows_json != null) {
    const stored = Array.isArray(row.windows_json) ? row.windows_json : [];
    const quotaUsages = stored.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const window = item as Record<string, unknown>;
      const percent = typeof window.usedPercent === "number" ? window.usedPercent
        : typeof window.percent === "number" ? window.percent : NaN;
      if (!Number.isFinite(percent)) return [];
      return [{
        ...(typeof window.label === "string" && window.label ? { label: window.label } : {}),
        percent,
        ...(window.resetAt !== undefined ? { resetAt: window.resetAt }
          : window.reset_at !== undefined ? { reset_at: window.reset_at } : {}),
      }];
    });
    const account = parseLlmQuotaAccount(row.account_json);
    const observation = routingQuotaObservation({
      quotaSource: "provider_api", quotaObservedAt: observedAt, quotaUsages,
      ...(account ? { quotaAccount: account } : {}),
    }, Date.now());
    if (observation) {
      return { remainingPercent: observation.value, observedAt: observation.observedAt,
        expiresAt: observation.expiresAt };
    }
  }
  const remaining = row?.remaining == null ? NaN : Number(row.remaining);
  const observed = new Date(row?.observed_at as string).getTime(), expires = new Date(row?.expires_at as string).getTime();
  return Number.isFinite(remaining) && remaining >= 0 && remaining <= 100 && Number.isFinite(observed) && Number.isFinite(expires)
    ? { remainingPercent: remaining, observedAt: new Date(observed).toISOString(), expiresAt: new Date(expires).toISOString() }
    : undefined;
}

export interface RegistrationQuotaProbeTarget {
  ownerUserId: string;
  machineId: string;
  hostId: string;
  harness: string;
  connectionEpoch: number;
  /** Server-bound pool the reading is written to; never daemon supplied. */
  quotaPoolId: string;
  /** Changes with the tuple, the probing host and the environment version. */
  configurationDigest: string;
  /** `registration:<harness>` as the daemon resolves it. */
  targetId: string;
}

/** Authorized registrations of one composite Space whose single online daemon
 * can run the quota probe. A legacy Space, a revoked grant, a disabled policy,
 * a departed owner, an environment without a declaration, or an ambiguous
 * machine (two online hosts) yields no target. The caller authorizes the actor
 * for the Space before asking. */
export async function readRegistrationQuotaProbeTargets(input: {
  database: AuthorityDatabase; directory: AuthorityDatabase; placement: DatabasePlacementContext; requestId: string;
  /** Skip a daemon that was already asked for its quota this recently, so
   * readers watching the Agents page share one reading per daemon. */
  probedWithinMs?: number;
}): Promise<RegistrationQuotaProbeTarget[]> {
  const registrations = await input.database.transaction({ requestId: input.requestId,
    operation: "registration.quota-probe.registrations", placement: input.placement }, async tx => {
    return tx.query<QueryResultRow>({ name: "registration_quota_probe_registrations_v1", text: `SELECT
        r.owner_user_id,r.machine_id,r.harness FROM data.space_agent_registrations r
        JOIN data.space_members m ON m.space_id=r.space_id AND m.user_id=r.owner_user_id
        JOIN data.space_agent_registration_access a ON a.space_id=r.space_id AND a.owner_user_id=r.owner_user_id
          AND a.machine_id=r.machine_id AND a.harness=r.harness
        WHERE r.space_id=$1 AND a.grant_state='active' AND a.policy_state='enabled'
        ORDER BY r.owner_user_id,r.machine_id,r.harness LIMIT 100`,
    values: [input.placement.spaceId], maxRows: 100 });
  });
  if (!registrations.length) return [];
  const rows = await input.directory.transaction({ requestId: input.requestId,
    operation: "registration.quota-probe.daemons" }, tx => tx.query<QueryResultRow>({
    name: "registration_quota_probe_daemons_v5", text: `SELECT requested.owner,requested.machine,requested.harness,
        e.version AS environment_version,${REGISTRATION_QUOTA_POOL_SQL} AS quota_pool_id,
        d.hostname,d.connection_epoch,
        $2::integer IS NOT NULL AND EXISTS (SELECT 1 FROM data.machine_daemon_commands probe
          WHERE probe.owner_user_id=requested.owner AND probe.machine_id=requested.machine
            AND probe.command_type='quota_probe'
            AND probe.created_at>statement_timestamp()-make_interval(secs=>$2::integer/1000.0)) AS recently_probed
      FROM jsonb_to_recordset($1::jsonb) AS requested(owner text,machine text,harness text)
      -- A disabled Agent takes no work, so its quota is not worth reading.
      JOIN control.agent_registration_environments e ON e.owner_user_id=requested.owner
        AND e.machine_id=requested.machine AND e.harness=requested.harness AND e.declaration_json->'enabled'='true'::jsonb
      JOIN LATERAL (SELECT daemon.hostname,daemon.connection_epoch FROM data.machine_daemons daemon
        WHERE daemon.owner_user_id=requested.owner AND daemon.machine_id=requested.machine
          AND daemon.status='online' AND daemon.capabilities_json ? 'machine_quota_probe_v2'
        ORDER BY daemon.hostname LIMIT 2) d ON TRUE
      ORDER BY requested.owner,requested.machine,requested.harness,d.hostname LIMIT 200`,
    values: [JSON.stringify(registrations.map(row => ({ owner: String(row.owner_user_id),
      machine: String(row.machine_id), harness: String(row.harness) }))), input.probedWithinMs ?? null], maxRows: 200 }));
  const hosts = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify([row.owner, row.machine, row.harness]);
    hosts.set(key, (hosts.get(key) ?? 0) + 1);
  }
  const targets: RegistrationQuotaProbeTarget[] = [];
  for (const row of rows) {
    const ownerUserId = String(row.owner), machineId = String(row.machine), harness = String(row.harness);
    const hostId = String(row.hostname ?? ""), connectionEpoch = Number(row.connection_epoch);
    const environmentVersion = Number(row.environment_version);
    // A spawn lands on one daemon; with two online hosts the probe cannot know which login it reads.
    if (hosts.get(JSON.stringify([ownerUserId, machineId, harness])) !== 1) continue;
    if (row.recently_probed === true) continue;
    if (!Number.isSafeInteger(connectionEpoch) || connectionEpoch < 1 ||
        !Number.isSafeInteger(environmentVersion) || environmentVersion < 1) continue;
    targets.push({ ownerUserId, machineId, hostId, harness, connectionEpoch,
      quotaPoolId: String(row.quota_pool_id),
      configurationDigest: await registrationQuotaProbeDigest({ ownerUserId, machineId, harness, environmentVersion }),
      targetId: `${REGISTRATION_QUOTA_PROBE_TARGET_PREFIX}${harness}` });
  }
  return targets;
}

function registrationQuotaProbeDigest(input: { ownerUserId: string; machineId: string;
  harness: string; environmentVersion: number }): Promise<string> {
  return digestCanonicalCloneCborV1({ kind: "registration-quota-probe", ...input });
}

/** Persist one owner's provider reading. A reading never replaces a newer one,
 * and one already expired is not written. */
export async function upsertRegistrationQuotaObservation(tx: DatabaseTransaction, input: {
  ownerUserId: string; quotaPoolId: string; remaining: number; observedAt: string; expiresAt: string;
  source: "provider" | "daemon";
  /** The provider windows behind `remaining`, shown on the Agents page. */
  windows?: readonly RoutingQuotaWindow[];
  /** The provider's verdict on the account from the same read. */
  account?: LlmQuotaAccount;
}): Promise<void> {
  await tx.query({ name: "registration_quota_observe_v4", text: `INSERT INTO control.registration_quota_observations
      (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,windows_json,account_json)
      SELECT $1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7::jsonb,$8::jsonb
      WHERE $4::timestamptz<=statement_timestamp() AND $5::timestamptz>statement_timestamp()
      ON CONFLICT (owner_user_id,quota_pool_id) DO UPDATE SET remaining=EXCLUDED.remaining,observed_at=EXCLUDED.observed_at,
        expires_at=EXCLUDED.expires_at,source=EXCLUDED.source,windows_json=EXCLUDED.windows_json,
        account_json=EXCLUDED.account_json
      WHERE EXCLUDED.observed_at>=registration_quota_observations.observed_at`,
    values: [input.ownerUserId, input.quotaPoolId, input.remaining, input.observedAt, input.expiresAt, input.source,
      input.windows?.length ? JSON.stringify(input.windows) : null, input.account ? JSON.stringify(input.account) : null],
    maxRows: 0 });
}

/** The daemon's completed quota probe is where its readings become facts, in
 * the completion's own transaction: nobody has to be waiting for the result.
 * Each reading lands only in the pool of the registration it was issued for,
 * and only while that registration is still at the version the probe was
 * issued against; a changed or removed registration writes nothing. */
export async function recordRegistrationQuotaProbeResult(tx: DatabaseTransaction, input: {
  ownerUserId: string; machineId: string; hostId: string; issued: RoutingQuotaProbeRequest; result: unknown; now: number;
}): Promise<number> {
  const readings = routingQuotaProbeObservations(input.result, input.issued, input.now);
  let recorded = 0;
  for (const reading of readings) {
    if (!reading.targetId.startsWith(REGISTRATION_QUOTA_PROBE_TARGET_PREFIX)) continue;
    const harness = reading.targetId.slice(REGISTRATION_QUOTA_PROBE_TARGET_PREFIX.length);
    const rows = await tx.query<QueryResultRow>({ name: "registration_quota_probe_result_target_v1", text: `SELECT
        e.version AS environment_version,${REGISTRATION_QUOTA_POOL_SQL} AS quota_pool_id
        FROM control.agent_registration_environments e
        WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=$3`,
    values: [input.ownerUserId, input.machineId, harness], maxRows: 1 });
    const row = rows[0];
    if (!row) continue;
    const digest = await registrationQuotaProbeDigest({ ownerUserId: input.ownerUserId, machineId: input.machineId,
      harness, environmentVersion: Number(row.environment_version) });
    if (digest !== reading.configurationDigest) continue;
    await upsertRegistrationQuotaObservation(tx, { ownerUserId: input.ownerUserId, quotaPoolId: String(row.quota_pool_id),
      remaining: reading.observation.value, observedAt: reading.observation.observedAt,
      expiresAt: reading.observation.expiresAt, source: "provider", windows: reading.windows,
      ...(reading.account ? { account: reading.account } : {}) });
    recorded++;
  }
  return recorded;
}

/** The longest a reported usage limit keeps a registration out of routing
 * when the provider gave no reset time, and the bounds on one it gave. */
const REGISTRATION_USAGE_LIMIT_DEFAULT_HOLD = "1 hour";
const REGISTRATION_USAGE_LIMIT_MIN_HOLD = "5 minutes";
const REGISTRATION_USAGE_LIMIT_MAX_HOLD = "7 days";

/** A live Instance of this registration reported its provider account's usage
 * limit used up: its pool reads empty until the reported reset, so routing and
 * handoff pass it over. A later provider probe replaces the reading. Returns
 * when the pool is held until, or undefined when nothing was written: the
 * registration has no environment on that machine, or a newer reading stands.
 * Retain unexpired provider window detail for display; the hold remains the
 * routing fact and cannot identify a window the provider never named. */
export async function recordRegistrationUsageLimit(tx: DatabaseTransaction, input: {
  ownerUserId: string; machineId: string; harness: string; resetsAt?: string;
}): Promise<{ quotaPoolId: string; limitedUntil: string } | undefined> {
  const resetsAt = input.resetsAt && Number.isFinite(Date.parse(input.resetsAt))
    ? new Date(input.resetsAt).toISOString() : null;
  const rows = await tx.query<QueryResultRow>({ name: "registration_usage_limit_observe_v3", text: `WITH pool AS (
      SELECT e.owner_user_id,${REGISTRATION_QUOTA_POOL_SQL} AS quota_pool_id,
        LEAST(GREATEST(COALESCE($4::timestamptz,statement_timestamp()+interval '${REGISTRATION_USAGE_LIMIT_DEFAULT_HOLD}'),
          statement_timestamp()+interval '${REGISTRATION_USAGE_LIMIT_MIN_HOLD}'),
          statement_timestamp()+interval '${REGISTRATION_USAGE_LIMIT_MAX_HOLD}') AS expires_at
      FROM control.agent_registration_environments e
      WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=$3)
    INSERT INTO control.registration_quota_observations
      (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,windows_json,account_json)
      SELECT owner_user_id,quota_pool_id,0,statement_timestamp(),expires_at,'daemon',NULL,NULL FROM pool
    ON CONFLICT (owner_user_id,quota_pool_id) DO UPDATE SET remaining=EXCLUDED.remaining,observed_at=EXCLUDED.observed_at,
      expires_at=EXCLUDED.expires_at,source=EXCLUDED.source,
      windows_json=CASE WHEN registration_quota_observations.expires_at>statement_timestamp()
        THEN registration_quota_observations.windows_json ELSE NULL END,
      account_json=EXCLUDED.account_json
      WHERE EXCLUDED.observed_at>=registration_quota_observations.observed_at
    RETURNING quota_pool_id,expires_at`,
  values: [input.ownerUserId, input.machineId, input.harness, resetsAt], maxRows: 1 });
  const row = rows[0];
  return row ? { quotaPoolId: String(row.quota_pool_id), limitedUntil: new Date(row.expires_at as string).toISOString() }
    : undefined;
}
