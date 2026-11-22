import { ACCOUNT_QUOTA_SCOPE, attributeRoutingQuotaRefusal, clampRoutingQuotaObservedTime, currentRoutingQuotaWindows,
  digestCanonicalCloneCborV1, mergeRoutingQuotaWindows, parseLlmQuotaAccount, quotaAccountBalance, routingModelOptionNamed,
  routingModelOptions, routingQuotaAccountPartExpiry, routingQuotaObservation, routingQuotaProbeObservations,
  routingQuotaVerdict, routingScopedQuotaExpiry, type RoutingBillingHolds, type RoutingQuotaVerdict, routingQuotaRecord,
  routingQuotaUsageWindows, UNRESOLVED_QUOTA_SCOPE, type AgentRegistrationLiveState, type LlmQuotaAccount,
  type LlmQuotaUsage, type LlmUsage, type RoutingModelOption, type RoutingQuotaProbeRequest, type RoutingQuotaRecord,
  type RoutingQuotaWindow } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabasePlacementContext } from "./context.js";
import { storedObject } from "./stored-values.js";

/** A registration target on the machine quota probe wire. Owner and machine are
 * the daemon route the probe is issued to; only the harness travels. */
export const REGISTRATION_QUOTA_PROBE_TARGET_PREFIX = "registration:";

/** The provider account a registered spawn uses is the machine owner's own
 * login for that harness on that machine, so a registration without a declared
 * shared pool is its own pool. Owner scoping comes from the observation row. */
export const REGISTRATION_QUOTA_POOL_SQL =
  `COALESCE(NULLIF(btrim(e.declaration_json->>'quotaPoolId'),''),'registration:'||e.machine_id||':'||e.harness)`;

/** Whether the pool reading `alias` is current: its account part, its scoped
 * part, or a scoped billing refusal still counts (see migration 0254). */
export function currentRegistrationQuotaSql(alias: string): string {
  return `${alias}.observed_at<=statement_timestamp() AND (${alias}.expires_at>statement_timestamp()
    OR ${alias}.scoped_expires_at>statement_timestamp()
    OR (${alias}.account_json ? 'billingRefusalScopes'
      AND jsonb_typeof(${alias}.account_json->'billingRefusalScopes')='object'
      AND ${alias}.account_json->'billingRefusalScopes'<>'{}'::jsonb))`;
}

/** The registration's pool reading while it is current, joined as `alias`
 * beside its environment row `e`. The Agents page and a launch read this one row. */
export function currentRegistrationQuotaJoin(alias: string): string {
  return `LEFT JOIN control.registration_quota_observations ${alias} ON ${alias}.owner_user_id=e.owner_user_id
    AND ${alias}.quota_pool_id=${REGISTRATION_QUOTA_POOL_SQL} AND ${currentRegistrationQuotaSql(alias)}`;
}

/** The columns `registrationQuotaUsage` reads of a pool reading `alias`. */
export function registrationQuotaColumns(alias: string): string {
  return ["source", "remaining", "observed_at", "expires_at", "windows_json", "account_json", "scoped_windows_json",
    "scoped_observed_at", "scoped_expires_at"].map(column => `${alias}.${column}`).join(",");
}

/** Whether a quota observation row holds an unresolved account billing/payment
 * refusal recorded by the daemon (`add a payment method`, `Insufficient Balance`). */
export function isRegistrationBillingRefusalRow(row: Record<string, unknown> | undefined, now = Date.now()): boolean {
  if (!row || row.source !== "daemon") return false;
  const expires = time(row.expires_at);
  if (!Number.isFinite(expires) || expires <= now) return false;
  return storedObject(row.account_json).billingRefusal === true;
}

/** Active per-scope billing/payment refusal holds stored on `account_json.billingRefusalScopes`. */
function registrationBillingRefusalScopeEntries(row: Record<string, unknown> | undefined, now = Date.now()):
  Array<{ scope: string; observedAt: number; expiresAt: number }> {
  const scopes = storedObject(storedObject(row?.account_json).billingRefusalScopes);
  const active: Array<{ scope: string; observedAt: number; expiresAt: number }> = [];
  for (const [rawScope, rawEntry] of Object.entries(scopes)) {
    const scope = rawScope.trim();
    if (!scope) continue;
    const entry = storedObject(rawEntry);
    const observedAt = time(entry.observedAt);
    const expiresAt = time(entry.expiresAt);
    if (!Number.isFinite(observedAt) || observedAt > now || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
    active.push({ scope, observedAt, expiresAt });
  }
  return active;
}

/** The quota scopes of `model` (or the runtime default when omitted) in a stored
 * Instance model catalog, normalized and non-empty. */
export function modelQuotaScopes(rawModels: unknown, model: string | undefined): string[] {
  const options = routingModelOptions(rawModels);
  const wanted = model?.trim();
  const entry = wanted ? options.find(option => routingModelOptionNamed(option, wanted))
    : options.find(option => option.isDefault);
  return entry?.quotaScopes?.map(scope => scope.trim()).filter(Boolean) ?? [];
}

/** A stored pool reading in usage form: account windows and the scoped
 * windows with their own read time. Readers derive any model's headroom from
 * it with `routingQuotaObservation`. */
export type RegistrationQuotaUsage = Omit<LlmUsage, "scopedQuotaUsages"> & {
  scopedQuotaObservedAt?: string;
  scopedQuotaUsages?: LlmQuotaUsage[];
  /** Payment refusals. Not quota windows: `routingQuotaVerdict` is the only
   * reader that turns them into "used up", and a named summon ignores them. */
  billingHolds?: RoutingBillingHolds;
};

const time = (value: unknown) => value instanceof Date ? value.getTime()
  : typeof value === "string" ? Date.parse(value) : NaN;

/** The pool reading of a row of `registrationQuotaColumns`, or none when
 * nothing counts at `now`. A windowless usage-limit hold (`source='daemon'`)
 * reads as one used-up account window until it ends. A billing refusal is
 * `billingHolds` beside the provider's own windows: an account hold, or one
 * hold per refused scope. It is not another window. */
export function registrationQuotaUsage(row: Record<string, unknown> | undefined, now = Date.now()):
  RegistrationQuotaUsage | undefined {
  const observed = clampRoutingQuotaObservedTime(time(row?.observed_at), now), expires = time(row?.expires_at);
  const scopedObserved = clampRoutingQuotaObservedTime(time(row?.scoped_observed_at), now);
  const scopedExpires = time(row?.scoped_expires_at);
  if (!row || observed === undefined) return undefined;
  const accountCurrent = expires > now;
  const scopedCurrent = scopedObserved !== undefined && scopedExpires > now;
  const billingScopes = registrationBillingRefusalScopeEntries(row, now);
  const hold = row.source === "daemon";
  const accountBilling = accountCurrent && hold && storedObject(row.account_json).billingRefusal === true;
  if (!accountCurrent && !scopedCurrent && !billingScopes.length) return undefined;
  const quotaAccount = accountCurrent && !hold ? parseLlmQuotaAccount(row.account_json) : undefined;
  // An account billing refusal is a hold, not a fabricated 100% window. A
  // usage-limit hold that names no window still reads as one used-up window.
  const quotaUsages = !accountCurrent || accountBilling ? [] : hold
    ? [{ percent: 100 - Number(row.remaining), resetAt: new Date(expires).toISOString() }]
    : routingQuotaUsageWindows(currentRoutingQuotaWindows(row.windows_json, now));
  const billingObserved = billingScopes.length ? Math.max(...billingScopes.map(entry => entry.observedAt)) : NaN;
  const quotaObservedMs = accountCurrent ? observed : scopedCurrent ? scopedObserved : billingObserved;
  const providerScoped = scopedCurrent
    ? routingQuotaUsageWindows(currentRoutingQuotaWindows(row.scoped_windows_json, now)) : [];
  const billingHolds: RoutingBillingHolds = {
    ...(accountBilling ? { accountUntil: new Date(expires).toISOString() } : {}),
    ...(billingScopes.length ? { scopes: billingScopes.map(entry => ({
      scope: entry.scope, until: new Date(entry.expiresAt).toISOString(),
    })) } : {}),
  };
  const hasHolds = billingHolds.accountUntil !== undefined || (billingHolds.scopes?.length ?? 0) > 0;
  return { quotaSource: "provider_api", quotaObservedAt: new Date(quotaObservedMs).toISOString(), quotaUsages,
    ...(scopedCurrent ? { scopedQuotaUsages: providerScoped,
      scopedQuotaObservedAt: new Date(scopedObserved).toISOString() } : {}),
    ...(hasHolds ? { billingHolds } : {}),
    ...(quotaAccount ? { quotaAccount } : {}) };
}

/** The joined reading as the headroom it leaves one model (its catalog row),
 * or the account alone without one, with its times; none when nothing counts. */
export function registrationQuotaReading(row: Record<string, unknown> | undefined,
  model?: Pick<RoutingModelOption, "quotaScopes">):
  { remainingPercent: number; observedAt: string; expiresAt: string } | undefined {
  const now = Date.now();
  const observation = routingQuotaObservation(registrationQuotaUsage(row, now), now, model ? { model } : undefined);
  return observation ? { remainingPercent: observation.value, observedAt: observation.observedAt,
    expiresAt: observation.expiresAt } : undefined;
}

/** Whether the joined reading leaves one model (its catalog row), or the
 * account without one, any quota (`routingQuotaVerdict`). */
export function registrationQuotaVerdict(row: Record<string, unknown> | undefined,
  model?: Pick<RoutingModelOption, "quotaScopes">): RoutingQuotaVerdict {
  const now = Date.now();
  return routingQuotaVerdict(registrationQuotaUsage(row, now), now, model ? { model } : undefined);
}

/** The headroom shown for a pool: the account's own, or, when no account
 * window counts and a provider scoped reading is current, that of its least
 * used scope (the best model it can run). A scope a billing hold refuses
 * reads as none left, so an open pool is the one shown. */
export function registrationShownQuotaReading(row: Record<string, unknown> | undefined):
  ReturnType<typeof registrationQuotaReading> {
  const now = Date.now();
  const account = registrationQuotaReading(row);
  if (account) return account;
  const scopedObserved = time(row?.scoped_observed_at), scopedExpires = time(row?.scoped_expires_at);
  if (!Number.isFinite(scopedObserved) || scopedObserved > now || scopedExpires <= now) return undefined;
  const scopes = new Set((registrationQuotaUsage(row, now)?.scopedQuotaUsages ?? []).flatMap(window =>
    window.scope ? [window.scope] : []));
  return [...scopes].flatMap(scope => registrationQuotaReading(row, { quotaScopes: [scope] }) ?? [])
    .sort((left, right) => right.remainingPercent - left.remainingPercent)[0];
}

/** Every window of a current pool reading as shown: its account windows, then
 * its provider-measured scoped ones (each with its scope). */
export function registrationQuotaWindows(row: Record<string, unknown> | undefined, now = Date.now()): RoutingQuotaWindow[] {
  const usage = registrationQuotaUsage(row, now);
  if (!usage) return [];
  const account = time(row?.expires_at) > now ? currentRoutingQuotaWindows(row?.windows_json, now) : [];
  const scopedObserved = time(row?.scoped_observed_at), scopedExpires = time(row?.scoped_expires_at);
  const scoped = Number.isFinite(scopedObserved) && scopedObserved <= now && scopedExpires > now
    ? currentRoutingQuotaWindows(row?.scoped_windows_json, now) : [];
  return [...account, ...scoped];
}

/**
 * How a current reading is listed for a registration. A prepaid account has no
 * window, so it is listed as `balance` (money) and never as `quota`: a client
 * that predates balances draws any `quota` as a percentage, and "100%" beside
 * an account with a few yuan left is wrong. Such a client reads nothing.
 */
export function registrationLiveQuota(reading: ReturnType<typeof registrationQuotaReading>,
  windows: readonly RoutingQuotaWindow[], account: LlmQuotaAccount | undefined): Pick<AgentRegistrationLiveState, "quota" | "balance"> {
  if (!reading) return {};
  const money = windows.length ? undefined : quotaAccountBalance(account);
  if (money) {
    return { balance: { ...money, ...(account?.allowed === undefined ? {} : { allowed: account.allowed }),
      observedAt: reading.observedAt, expiresAt: reading.expiresAt } };
  }
  return { quota: { ...reading, ...(windows.length ? { windows: [...windows] } : {}), ...(account ? { account } : {}) } };
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
  /** Its pool is under a usage-limit hold no window explains, recorded at
   * this time: only a fresh complete reading newer than it can narrow it. */
  heldSince?: string;
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
  /** Only registrations whose pool has no current reading: a pool an
   * Instance or an earlier read keeps current needs no request. A pool under
   * a windowless usage-limit hold counts as unread: the hold waits for a read
   * to tell what was used up. */
  onlyUnread?: boolean;
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
  return registrationQuotaProbeTargets(input.directory, { requestId: input.requestId,
    registrations: registrations.map(row => ({ ownerUserId: String(row.owner_user_id), machineId: String(row.machine_id),
      harness: String(row.harness) })),
    ...(input.probedWithinMs !== undefined ? { probedWithinMs: input.probedWithinMs } : {}),
    ...(input.onlyUnread ? { onlyUnread: true } : {}) });
}

/** A windowless usage-limit hold of the pool reading `q` that no complete
 * reading has followed: only such a read can tell what was used up. One that
 * came and explained nothing leaves the hold to its end, read as usual. */
const UNREAD_HOLD_SQL = `(q.source='daemon' AND q.expires_at>statement_timestamp()
  AND (q.scoped_observed_at IS NULL OR q.scoped_observed_at<q.observed_at))`;
/** A row kept joined solely by `billingRefusalScopes` still has no current
 * provider reading and should be probed when `onlyUnread` is set. */
const UNREAD_PROVIDER_SQL = `(q.expires_at<=statement_timestamp()
  AND (q.scoped_expires_at IS NULL OR q.scoped_expires_at<=statement_timestamp()))`;

/** Probe targets for these registrations whose single online daemon can read
 * their quota (see `readRegistrationQuotaProbeTargets`). The caller has
 * authorized the registrations: a Space's, or those a refused summon names. */
export async function registrationQuotaProbeTargets(directory: AuthorityDatabase, input: {
  requestId: string; registrations: ReadonlyArray<{ ownerUserId: string; machineId: string; harness: string }>;
  probedWithinMs?: number; onlyUnread?: boolean;
}): Promise<RegistrationQuotaProbeTarget[]> {
  const registrations = input.registrations.slice(0, 100);
  if (!registrations.length) return [];
  const rows = await directory.transaction({ requestId: input.requestId,
    operation: "registration.quota-probe.daemons" }, tx => tx.query<QueryResultRow>({
    name: "registration_quota_probe_daemons_v9", text: `SELECT requested.owner,requested.machine,requested.harness,
        e.version AS environment_version,${REGISTRATION_QUOTA_POOL_SQL} AS quota_pool_id,
        d.hostname,d.connection_epoch,CASE WHEN ${UNREAD_HOLD_SQL} THEN to_json(q.observed_at)#>>'{}' END AS held_since,
        $2::integer IS NOT NULL AND EXISTS (SELECT 1 FROM data.machine_daemon_commands probe
          WHERE probe.owner_user_id=requested.owner AND probe.machine_id=requested.machine
            AND probe.command_type='quota_probe'
            AND probe.created_at>statement_timestamp()-make_interval(secs=>$2::integer/1000.0)) AS recently_probed
      FROM jsonb_to_recordset($1::jsonb) AS requested(owner text,machine text,harness text)
      -- A disabled Agent takes no work, so its quota is not worth reading.
      JOIN control.agent_registration_environments e ON e.owner_user_id=requested.owner
        AND e.machine_id=requested.machine AND e.harness=requested.harness AND e.declaration_json->'enabled'='true'::jsonb
      ${currentRegistrationQuotaJoin("q")}
      JOIN LATERAL (SELECT daemon.hostname,daemon.connection_epoch FROM data.machine_daemons daemon
        WHERE daemon.owner_user_id=requested.owner AND daemon.machine_id=requested.machine
          AND daemon.status='online' AND daemon.capabilities_json ? 'machine_quota_probe_v2'
        ORDER BY daemon.hostname LIMIT 2) d ON TRUE
      WHERE $3::boolean IS NOT TRUE OR q.owner_user_id IS NULL OR ${UNREAD_HOLD_SQL} OR ${UNREAD_PROVIDER_SQL}
      ORDER BY requested.owner,requested.machine,requested.harness,d.hostname LIMIT 200`,
    values: [JSON.stringify(registrations.map(row => ({ owner: row.ownerUserId, machine: row.machineId,
      harness: row.harness }))), input.probedWithinMs ?? null, input.onlyUnread === true], maxRows: 200 }));
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
      targetId: `${REGISTRATION_QUOTA_PROBE_TARGET_PREFIX}${harness}`,
      ...(typeof row.held_since === "string" ? { heldSince: row.held_since } : {}) });
  }
  return targets;
}

function registrationQuotaProbeDigest(input: { ownerUserId: string; machineId: string;
  harness: string; environmentVersion: number }): Promise<string> {
  return digestCanonicalCloneCborV1({ kind: "registration-quota-probe", ...input });
}

export { ACCOUNT_QUOTA_SCOPE, UNRESOLVED_QUOTA_SCOPE } from "@xmatrix/protocol";

export interface RegistrationQuotaPoolKey {
  ownerUserId: string;
  quotaPoolId: string;
}

/** Maximum unready waiters one bounded pool reconciliation page marks ready. */
export const QUOTA_WAITER_RECONCILE_PAGE_SIZE = 128;

/**
 * Serialize observation transitions, holds, wait registrations and waiter
 * reconciliation on the same pool using a single deterministic lock order
 * `(ownerUserId, quotaPoolId)` without blocking unrelated pools or requiring
 * an observation row to exist yet.
 */
export async function lockRegistrationQuotaPools(
  tx: DatabaseTransaction,
  pools: readonly RegistrationQuotaPoolKey[],
): Promise<RegistrationQuotaPoolKey[]> {
  const unique = [...new Map(
    pools.map(pool => [`${pool.ownerUserId.length}:${pool.ownerUserId}:${pool.quotaPoolId}`, pool]),
  ).values()].sort((left, right) =>
    left.ownerUserId < right.ownerUserId ? -1
      : left.ownerUserId > right.ownerUserId ? 1
      : left.quotaPoolId < right.quotaPoolId ? -1
      : left.quotaPoolId > right.quotaPoolId ? 1 : 0,
  );
  if (!unique.length) return [];
  await tx.query({
    name: "registration_quota_pools_lock_v1",
    text: `WITH ordered AS MATERIALIZED (
        SELECT p.owner, p.pool
        FROM jsonb_to_recordset($1::jsonb) AS p(owner text, pool text)
        ORDER BY p.owner, p.pool
      )
      SELECT pg_advisory_xact_lock(
        hashtextextended('registration_quota_pool:' || length(owner)::text || ':' || owner || ':' || pool, 0)
      ) FROM ordered`,
    values: [JSON.stringify(unique.map(pool => ({ owner: pool.ownerUserId, pool: pool.quotaPoolId })))],
    maxRows: unique.length,
  });
  return unique;
}

/** Read a pool's current observation row (caller holds the pool lock when serializing transitions). */
export async function readCurrentRegistrationQuotaPoolObservation(
  tx: DatabaseTransaction,
  ownerUserId: string,
  quotaPoolId: string,
): Promise<QueryResultRow | undefined> {
  const [obs] = await tx.query<QueryResultRow>({
    name: "registration_quota_pool_obs_read_v1",
    text: `SELECT ${registrationQuotaColumns("q")}
      FROM control.registration_quota_observations q
      WHERE q.owner_user_id=$1 AND q.quota_pool_id=$2 AND ${currentRegistrationQuotaSql("q")}`,
    values: [ownerUserId, quotaPoolId],
    maxRows: 1,
  });
  return obs;
}

/**
 * Atomically advance a pool's observation revision and either arm a fresh
 * durable reconciliation obligation (when the pool has headroom) or clear any
 * stale pending obligation (when an exhausted reading or hold replaces it).
 */
export async function recordPoolReconciliationTransition(
  tx: DatabaseTransaction,
  ownerUserId: string,
  quotaPoolId: string,
  open: boolean,
): Promise<void> {
  if (open) {
    await tx.query({
      name: "registration_quota_pool_reconcile_arm_v1",
      text: `INSERT INTO control.registration_quota_pool_reconciliations
          (owner_user_id,quota_pool_id,observation_revision,reconcile_needed_revision,reconciled_revision,
            reconcile_cursor_channel_id,updated_at)
        VALUES ($1,$2,1,1,0,NULL,clock_timestamp())
        ON CONFLICT (owner_user_id,quota_pool_id) DO UPDATE SET
          observation_revision=registration_quota_pool_reconciliations.observation_revision + 1,
          reconcile_needed_revision=registration_quota_pool_reconciliations.observation_revision + 1,
          reconcile_cursor_channel_id=NULL,
          updated_at=clock_timestamp()`,
      values: [ownerUserId, quotaPoolId],
      maxRows: 0,
    });
    return;
  }
  await tx.query({
    name: "registration_quota_pool_reconcile_clear_v1",
    text: `INSERT INTO control.registration_quota_pool_reconciliations
        (owner_user_id,quota_pool_id,observation_revision,reconcile_needed_revision,reconciled_revision,
          reconcile_cursor_channel_id,updated_at)
      VALUES ($1,$2,1,0,0,NULL,clock_timestamp())
      ON CONFLICT (owner_user_id,quota_pool_id) DO UPDATE SET
        observation_revision=registration_quota_pool_reconciliations.observation_revision + 1,
        reconciled_revision=registration_quota_pool_reconciliations.reconcile_needed_revision,
        reconcile_cursor_channel_id=NULL,
        updated_at=clock_timestamp()`,
    values: [ownerUserId, quotaPoolId],
    maxRows: 0,
  });
}

/**
 * Reconcile one bounded page of unready waiters belonging solely to
 * `(ownerUserId, quotaPoolId)`. Advances the durable channel cursor when more
 * rows remain, and acknowledges `reconciled_revision` only when the pool is
 * completely drained at its current observation revision.
 */
export async function reconcileRegistrationQuotaPoolPage(
  tx: DatabaseTransaction,
  input: { ownerUserId: string; quotaPoolId: string; pageSize?: number; observation?: QueryResultRow },
): Promise<{ readied: number; hasReady: boolean; more: boolean }> {
  const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? QUOTA_WAITER_RECONCILE_PAGE_SIZE), 1), 256);
  const obs = input.observation ?? await readCurrentRegistrationQuotaPoolObservation(tx, input.ownerUserId, input.quotaPoolId);
  const [state] = await tx.query<QueryResultRow>({
    name: "registration_quota_pool_reconcile_read_v1",
    text: `SELECT reconcile_needed_revision,reconciled_revision,reconcile_cursor_channel_id
      FROM control.registration_quota_pool_reconciliations
      WHERE owner_user_id=$1 AND quota_pool_id=$2 FOR UPDATE`,
    values: [input.ownerUserId, input.quotaPoolId],
    maxRows: 1,
  });
  const open = obs !== undefined && registrationQuotaVerdict(obs).state !== "usedUp";
  if (!open) {
    if (state && (Number(state.reconcile_needed_revision) > Number(state.reconciled_revision)
        || state.reconcile_cursor_channel_id !== null)) {
      await tx.query({
        name: "registration_quota_pool_reconcile_ack_v1",
        text: `UPDATE control.registration_quota_pool_reconciliations
          SET reconciled_revision=reconcile_needed_revision,reconcile_cursor_channel_id=NULL,updated_at=clock_timestamp()
          WHERE owner_user_id=$1 AND quota_pool_id=$2`,
        values: [input.ownerUserId, input.quotaPoolId],
        maxRows: 0,
      });
    }
    return { readied: 0, hasReady: false, more: false };
  }

  const cursor = typeof state?.reconcile_cursor_channel_id === "string" ? state.reconcile_cursor_channel_id : null;
  const candidates = await tx.query<QueryResultRow>({
    name: "registration_quota_pool_waiters_page_v1",
    text: `SELECT channel_id
      FROM control.registration_quota_waiters
      WHERE owner_user_id=$1 AND quota_pool_id=$2
        AND ready_at IS NULL AND expires_at>statement_timestamp()
        AND refused_through<$3::timestamptz
        AND ($4::text IS NULL OR channel_id>$4)
      ORDER BY channel_id ASC
      LIMIT $5`,
    values: [input.ownerUserId, input.quotaPoolId, obs.observed_at, cursor, pageSize],
    maxRows: pageSize,
  });

  let readied = 0;
  if (candidates.length) {
    const channelIds = candidates.map(row => String(row.channel_id));
    const updated = await tx.query<QueryResultRow>({
      name: "registration_quota_pool_waiters_ready_v1",
      text: `UPDATE control.registration_quota_waiters
        SET ready_at=clock_timestamp(),ready_token=gen_random_uuid()
        WHERE owner_user_id=$1 AND quota_pool_id=$2
          AND channel_id=ANY($3::text[]) AND ready_at IS NULL
        RETURNING channel_id`,
      values: [input.ownerUserId, input.quotaPoolId, channelIds],
      maxRows: channelIds.length,
    });
    readied = updated.length;
  }

  const more = candidates.length >= pageSize;
  if (state) {
    if (more) {
      const nextCursor = String(candidates[candidates.length - 1]!.channel_id);
      await tx.query({
        name: "registration_quota_pool_reconcile_cursor_v1",
        text: `UPDATE control.registration_quota_pool_reconciliations
          SET reconcile_cursor_channel_id=$3,updated_at=clock_timestamp()
          WHERE owner_user_id=$1 AND quota_pool_id=$2`,
        values: [input.ownerUserId, input.quotaPoolId, nextCursor],
        maxRows: 0,
      });
    } else if (Number(state.reconcile_needed_revision) > Number(state.reconciled_revision) || cursor !== null) {
      await tx.query({
        name: "registration_quota_pool_reconcile_ack_v1",
        text: `UPDATE control.registration_quota_pool_reconciliations
          SET reconciled_revision=reconcile_needed_revision,reconcile_cursor_channel_id=NULL,updated_at=clock_timestamp()
          WHERE owner_user_id=$1 AND quota_pool_id=$2`,
        values: [input.ownerUserId, input.quotaPoolId],
        maxRows: 0,
      });
    }
  }

  let hasReady = readied > 0;
  if (!hasReady) {
    const existingReady = await tx.query<QueryResultRow>({
      name: "registration_quota_pool_has_ready_v1",
      text: `SELECT 1 FROM control.registration_quota_waiters
        WHERE owner_user_id=$1 AND quota_pool_id=$2 AND ready_at IS NOT NULL AND expires_at>statement_timestamp()
        LIMIT 1`,
      values: [input.ownerUserId, input.quotaPoolId],
      maxRows: 1,
    });
    hasReady = existingReady.length > 0;
  }
  return { readied, hasReady, more };
}

/** Persist one owner's provider reading, each part fenced on its own read
 * time: every reading renews the account part, a complete one the scoped part
 * too. A reading never replaces a newer one, and one already expired is not
 * written. A complete reading over a windowless usage-limit hold that shows
 * the window resetting when the hold ends reads it as the one used up
 * (`attributeRoutingQuotaRefusal`) and replaces the hold; one that shows none
 * leaves the hold until it ends. Window merging, remaining headroom and
 * 31-day exhausted holds are derived once in `@xmatrix/protocol`, never in SQL. */
export async function upsertRegistrationQuotaObservation(tx: DatabaseTransaction, input: {
  ownerUserId: string; quotaPoolId: string; record: RoutingQuotaRecord;
}): Promise<boolean> {
  await lockRegistrationQuotaPools(tx, [{ ownerUserId: input.ownerUserId, quotaPoolId: input.quotaPoolId }]);
  const incoming = input.record;
  const incomingAccountExpiry = routingQuotaAccountPartExpiry(incoming);
  const incomingScopedExpiry = incoming.scoped?.expiresAt ?? null;
  let effectiveAccountRemaining = incoming.account?.value ?? 100;

  for (let attempt = 0; attempt < 2; attempt++) {
    const inserted = await tx.query<QueryResultRow>({ name: "registration_quota_observe_insert_v1", text: `INSERT INTO
        control.registration_quota_observations
        (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,windows_json,account_json,
          scoped_windows_json,scoped_observed_at,scoped_expires_at)
      SELECT $1,$2,$3,LEAST($4::timestamptz,statement_timestamp()),$5::timestamptz,'provider',$6::jsonb,$7::jsonb,$8::jsonb,
        CASE WHEN $9::timestamptz IS NULL THEN NULL ELSE LEAST($9::timestamptz,statement_timestamp()) END,$10::timestamptz
      WHERE $4::timestamptz<=statement_timestamp()+interval '5 seconds'
        AND GREATEST($5::timestamptz,$10::timestamptz)>statement_timestamp()
      ON CONFLICT (owner_user_id,quota_pool_id) DO NOTHING
      RETURNING 1 AS inserted`,
    values: [input.ownerUserId, input.quotaPoolId, incoming.account?.value ?? 100, incoming.observedAt,
      incomingAccountExpiry, incoming.windows.length ? JSON.stringify(incoming.windows) : null,
      incoming.quotaAccount ? JSON.stringify(incoming.quotaAccount) : null,
      incoming.scoped ? JSON.stringify(incoming.scoped.windows) : null, incoming.scoped ? incoming.observedAt : null,
      incomingScopedExpiry], maxRows: 1 });
    if (inserted.length > 0) break;

    const [existing] = await tx.query<QueryResultRow>({ name: "registration_quota_observe_lock_v1", text: `SELECT
        to_json(statement_timestamp())#>>'{}' AS server_now,source,remaining,
        to_json(observed_at)#>>'{}' AS observed_at,to_json(expires_at)#>>'{}' AS expires_at,
        windows_json,account_json,scoped_windows_json,
        to_json(scoped_observed_at)#>>'{}' AS scoped_observed_at,
        to_json(scoped_expires_at)#>>'{}' AS scoped_expires_at
      FROM control.registration_quota_observations
      WHERE owner_user_id=$1 AND quota_pool_id=$2 FOR UPDATE`,
    values: [input.ownerUserId, input.quotaPoolId], maxRows: 1 });
    if (!existing) continue;

    const serverNow = time(existing.server_now);
    const clampedObserved = clampRoutingQuotaObservedTime(Date.parse(incoming.observedAt), serverNow);
    const maxExpiry = Math.max(Date.parse(incomingAccountExpiry),
      incomingScopedExpiry ? Date.parse(incomingScopedExpiry) : -Infinity);
    if (clampedObserved === undefined || !(maxExpiry > serverNow)) {
      effectiveAccountRemaining = Number(existing.remaining);
      break;
    }

    let record = incoming;
    let explainsHold = false;
    const existingObserved = time(existing.observed_at);
    const existingExpires = time(existing.expires_at);
    const existingAccountObj = storedObject(existing.account_json);
    const existingIsBillingHold = existingAccountObj.billingRefusal === true;
    if (record.scoped && existing.source === "daemon" && existingExpires > serverNow
        && !existingIsBillingHold && existingObserved <= clampedObserved) {
      const narrowed = attributeRoutingQuotaRefusal(record, existingExpires, serverNow);
      if (narrowed) { record = narrowed.record; explainsHold = true; }
    }

    const accountPartNewer = clampedObserved >= existingObserved
      && (existing.source !== "daemon" || existingExpires <= serverNow || (explainsHold && !existingIsBillingHold));
    const existingScopedObserved = time(existing.scoped_observed_at);
    const scopedPartNewer = record.scoped !== undefined
      && (!Number.isFinite(existingScopedObserved) || clampedObserved >= existingScopedObserved);
    if (!accountPartNewer && !scopedPartNewer) {
      effectiveAccountRemaining = Number(existing.remaining);
      break;
    }

    const clampedObservedIso = new Date(clampedObserved).toISOString();
    let nextRemaining = Number(existing.remaining);
    let nextObservedAt = String(existing.observed_at);
    let nextExpiresAt = String(existing.expires_at);
    let nextSource = String(existing.source);
    let nextWindowsJson: unknown = existing.windows_json;
    let nextAccountJson: unknown = existing.account_json;
    let nextScopedWindowsJson: unknown = existing.scoped_windows_json;
    let nextScopedObservedAt: string | null = existing.scoped_observed_at ? String(existing.scoped_observed_at) : null;
    let nextScopedExpiresAt: string | null = existing.scoped_expires_at ? String(existing.scoped_expires_at) : null;

    if (accountPartNewer) {
      const storedAccountWindows = currentRoutingQuotaWindows(existing.windows_json, serverNow);
      const mergedWindows = mergeRoutingQuotaWindows(record.windows, storedAccountWindows);
      const accountMergedRecord = routingQuotaRecord({
        quotaSource: "provider_api",
        quotaObservedAt: clampedObservedIso,
        quotaUsages: routingQuotaUsageWindows(mergedWindows),
        ...(record.scoped ? { scopedQuotaUsages: routingQuotaUsageWindows(record.scoped.windows) } : {}),
        ...(record.quotaAccount ? { quotaAccount: record.quotaAccount } : {}),
      }, serverNow);
      nextWindowsJson = mergedWindows.length ? mergedWindows : null;
      nextRemaining = accountMergedRecord?.account?.value ?? record.account?.value ?? 100;
      nextObservedAt = clampedObservedIso;
      nextExpiresAt = accountMergedRecord ? routingQuotaAccountPartExpiry(accountMergedRecord)
        : routingQuotaAccountPartExpiry({ ...record, observedAt: clampedObservedIso });
      nextSource = "provider";
      if ("billingRefusalScopes" in existingAccountObj) {
        nextAccountJson = { ...record.quotaAccount, billingRefusalScopes: existingAccountObj.billingRefusalScopes };
      } else {
        nextAccountJson = record.quotaAccount ?? null;
      }
      effectiveAccountRemaining = nextRemaining;
    } else {
      effectiveAccountRemaining = Number(existing.remaining);
    }

    if (scopedPartNewer && record.scoped) {
      const storedScopedWindows = currentRoutingQuotaWindows(existing.scoped_windows_json, serverNow);
      const mergedScopedWindows = mergeRoutingQuotaWindows(record.scoped.windows, storedScopedWindows);
      nextScopedWindowsJson = mergedScopedWindows;
      nextScopedObservedAt = clampedObservedIso;
      nextScopedExpiresAt = routingScopedQuotaExpiry({
        quotaSource: "provider_api",
        quotaObservedAt: clampedObservedIso,
        scopedQuotaUsages: routingQuotaUsageWindows(mergedScopedWindows),
        ...(record.quotaAccount ? { quotaAccount: record.quotaAccount } : {}),
      }, serverNow) ?? null;
    }

    await tx.query({ name: "registration_quota_observe_update_v1", text: `UPDATE control.registration_quota_observations
      SET remaining=$3,observed_at=$4::timestamptz,expires_at=$5::timestamptz,source=$6,
        windows_json=$7::jsonb,account_json=$8::jsonb,scoped_windows_json=$9::jsonb,
        scoped_observed_at=$10::timestamptz,scoped_expires_at=$11::timestamptz
      WHERE owner_user_id=$1 AND quota_pool_id=$2`,
    values: [
      input.ownerUserId, input.quotaPoolId, nextRemaining, nextObservedAt, nextExpiresAt, nextSource,
      nextWindowsJson === null ? null : JSON.stringify(nextWindowsJson),
      nextAccountJson === null ? null : JSON.stringify(nextAccountJson),
      nextScopedWindowsJson === null ? null : JSON.stringify(nextScopedWindowsJson),
      nextScopedObservedAt, nextScopedExpiresAt,
    ], maxRows: 0 });
    break;
  }

  // Persist the pool's observation revision and reconciliation obligation
  // atomically under the per-pool lock, then drain one bounded page of this
  // pool's unready waiters. Any remainder stays durably pending via the cursor.
  const current = await readCurrentRegistrationQuotaPoolObservation(tx, input.ownerUserId, input.quotaPoolId);
  if (!current) return false;
  const poolOpen = effectiveAccountRemaining > 0 && registrationQuotaVerdict(current).state !== "usedUp";
  await recordPoolReconciliationTransition(tx, input.ownerUserId, input.quotaPoolId, poolOpen);
  if (!poolOpen) return false;
  const page = await reconcileRegistrationQuotaPoolPage(tx, {
    ownerUserId: input.ownerUserId,
    quotaPoolId: input.quotaPoolId,
    observation: current,
  });
  return page.readied > 0 || page.hasReady || page.more;
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
      record: reading.record });
    recorded++;
  }
  return recorded;
}

/** The longest a reported usage limit keeps a registration out of routing
 * when the provider gave no reset time, and the bounds on one it gave. */
const REGISTRATION_USAGE_LIMIT_DEFAULT_HOLD = "1 hour";
const REGISTRATION_USAGE_LIMIT_MIN_HOLD = "5 minutes";
const REGISTRATION_USAGE_LIMIT_MAX_HOLD = "7 days";
const REGISTRATION_BILLING_REFUSAL_HOLD = "365 days";

/** What a recorded usage limit used up: the account (every model of the
 * pool), one scope (the models whose catalog row lists it), or something no
 * window explains (the whole pool, held without a window). */
export type RegistrationUsageLimit = { quotaPoolId: string; limitedUntil?: string } & (
  | { usedUp: "account" } | { usedUp: "scope"; scope: string } | { usedUp: "unresolved" });

/**
 * A live Instance of this registration reported a turn refused for its
 * provider usage limit, with what the daemon told it used up (`quotaScope`)
 * from a complete reading it took after the refusal (`usage`). The hold and
 * the reading are written together, in the caller's transaction:
 *
 * - a scope, or `account`: the reading, with the window of that scope (the
 *   account's) resetting when the refusal said read as used up. A scope blocks
 *   only its models; the account, every model of the pool.
 * - `unresolved`, a scope the reading does not show, or no scope (a daemon
 *   that predates scopes, which means the account): the reading, under a
 *   windowless hold of the whole pool until the reset. A later complete
 *   reading replaces the hold, reading the window that resets with it as the
 *   used-up one (`upsertRegistrationQuotaObservation`).
 *
 * Undefined when the registration has no environment on that machine or a
 * newer reading stands.
 */
export async function recordRegistrationUsageLimit(tx: DatabaseTransaction, input: {
  ownerUserId: string; machineId: string; harness: string; resetsAt?: string; quotaScope?: string;
  quotaScopeReason?: string; usage?: unknown; billingRefusal?: boolean;
}): Promise<RegistrationUsageLimit | undefined> {
  const now = Date.now();
  const reset = input.resetsAt ? Date.parse(input.resetsAt) : NaN;
  const [pool] = await tx.query<QueryResultRow>({ name: "registration_usage_limit_pool_v1", text: `SELECT
      ${REGISTRATION_QUOTA_POOL_SQL} AS quota_pool_id FROM control.agent_registration_environments e
    WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=$3`,
  values: [input.ownerUserId, input.machineId, input.harness], maxRows: 1 });
  if (!pool) return undefined;
  const quotaPoolId = String(pool.quota_pool_id);
  await lockRegistrationQuotaPools(tx, [{ ownerUserId: input.ownerUserId, quotaPoolId }]);
  if (input.billingRefusal) {
    const scope = input.quotaScope?.trim();
    if (scope && scope !== ACCOUNT_QUOTA_SCOPE && scope !== UNRESOLVED_QUOTA_SCOPE) {
      // Scoped billing/payment refusal (e.g. Cursor's `API` pool requiring a
      // payment method while `Auto` stays included): hold only this scope in
      // `account_json.billingRefusalScopes` without wiping provider readings.
      const legacyHold = `o.source='daemon' AND COALESCE((o.account_json->>'billingRefusal')::boolean,FALSE)`;
      const entry = `jsonb_build_object($3::text,jsonb_build_object(
        'observedAt',to_json(statement_timestamp())#>>'{}',
        'expiresAt',to_json(statement_timestamp()+interval '${REGISTRATION_BILLING_REFUSAL_HOLD}')#>>'{}'))`;
      const rows = await tx.query<QueryResultRow>({ name: "registration_usage_limit_billing_scope_v1", text: `INSERT INTO
          control.registration_quota_observations AS o (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,
            windows_json,account_json,scoped_windows_json,scoped_observed_at,scoped_expires_at)
          SELECT $1,$2,100,statement_timestamp()-interval '1 millisecond',statement_timestamp(),'provider',NULL,
            jsonb_build_object('billingRefusalScopes',${entry}),NULL,NULL,NULL
        ON CONFLICT (owner_user_id,quota_pool_id) DO UPDATE SET
          remaining=CASE WHEN ${legacyHold} THEN 100 ELSE o.remaining END,
          observed_at=CASE WHEN ${legacyHold} THEN statement_timestamp()-interval '1 millisecond' ELSE o.observed_at END,
          expires_at=CASE WHEN ${legacyHold} THEN statement_timestamp() ELSE o.expires_at END,
          source=CASE WHEN ${legacyHold} THEN 'provider' ELSE o.source END,
          account_json=(CASE WHEN ${legacyHold} THEN COALESCE(o.account_json,'{}'::jsonb)-'billingRefusal'
            ELSE COALESCE(o.account_json,'{}'::jsonb) END) || jsonb_build_object('billingRefusalScopes',
            COALESCE((SELECT jsonb_object_agg(e.key,e.value)
              FROM jsonb_each(CASE WHEN jsonb_typeof(o.account_json->'billingRefusalScopes')='object'
                THEN o.account_json->'billingRefusalScopes' ELSE '{}'::jsonb END) e
              WHERE lower(btrim(e.key))<>lower($3::text)),'{}'::jsonb) || ${entry})
        RETURNING to_json(statement_timestamp()+interval '${REGISTRATION_BILLING_REFUSAL_HOLD}')#>>'{}' AS expires_at`,
      values: [input.ownerUserId, quotaPoolId, scope], maxRows: 1 });
      const limitedUntil = rows[0] ? new Date(String(rows[0].expires_at)).toISOString() : undefined;
      return { quotaPoolId, ...(limitedUntil ? { limitedUntil } : {}), usedUp: "scope", scope };
    }
    // Account-level billing/payment refusals have no reset timer and do not return to @auto
    // until a direct Run succeeds on this registration.
    const rows = await tx.query<QueryResultRow>({ name: "registration_usage_limit_billing_v1", text: `INSERT INTO
        control.registration_quota_observations AS o (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,
          windows_json,account_json,scoped_windows_json,scoped_observed_at,scoped_expires_at)
        SELECT $1,$2,0,statement_timestamp(),statement_timestamp()+interval '${REGISTRATION_BILLING_REFUSAL_HOLD}',
          'daemon',NULL,'{"billingRefusal":true}'::jsonb,NULL,NULL,NULL
      ON CONFLICT (owner_user_id,quota_pool_id) DO UPDATE SET remaining=EXCLUDED.remaining,observed_at=EXCLUDED.observed_at,
        expires_at=EXCLUDED.expires_at,source=EXCLUDED.source,windows_json=NULL,account_json=EXCLUDED.account_json,
        scoped_windows_json=NULL,scoped_observed_at=NULL,scoped_expires_at=NULL
        WHERE EXCLUDED.observed_at>=o.observed_at
      RETURNING to_json(expires_at)#>>'{}' AS expires_at`,
    values: [input.ownerUserId, quotaPoolId], maxRows: 1 });
    const limitedUntil = rows[0] ? new Date(String(rows[0].expires_at)).toISOString() : undefined;
    if (rows[0]) await recordPoolReconciliationTransition(tx, input.ownerUserId, quotaPoolId, false);
    return { quotaPoolId, ...(limitedUntil ? { limitedUntil } : {}), usedUp: "account" };
  }
  const record = input.usage === undefined ? undefined : routingQuotaRecord(input.usage, now);
  const scope = input.quotaScope?.trim() || undefined;
  const scopeReason = input.quotaScopeReason?.trim() || undefined;
  const attributed = record?.scoped && Number.isFinite(reset) && scope !== UNRESOLVED_QUOTA_SCOPE
    ? attributeRoutingQuotaRefusal(record, reset, now, scope) : undefined;
  if (attributed) {
    await upsertRegistrationQuotaObservation(tx, { ownerUserId: input.ownerUserId, quotaPoolId, record: attributed.record });
    const limitedUntil = new Date(reset).toISOString();
    return attributed.usedUp === "account" ? { quotaPoolId, limitedUntil, usedUp: "account" }
      : { quotaPoolId, limitedUntil, usedUp: "scope", scope: attributed.scope };
  }
  if (record) await upsertRegistrationQuotaObservation(tx, { ownerUserId: input.ownerUserId, quotaPoolId, record });
  const rows = await tx.query<QueryResultRow>({ name: "registration_usage_limit_observe_v4", text: `INSERT INTO
      control.registration_quota_observations AS o (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,
        windows_json,account_json)
      SELECT $1,$2,0,statement_timestamp(),LEAST(GREATEST(
          COALESCE($3::timestamptz,statement_timestamp()+interval '${REGISTRATION_USAGE_LIMIT_DEFAULT_HOLD}'),
          statement_timestamp()+interval '${REGISTRATION_USAGE_LIMIT_MIN_HOLD}'),
        statement_timestamp()+interval '${REGISTRATION_USAGE_LIMIT_MAX_HOLD}'),'daemon',NULL,NULL
    ON CONFLICT (owner_user_id,quota_pool_id) DO UPDATE SET remaining=EXCLUDED.remaining,observed_at=EXCLUDED.observed_at,
      expires_at=EXCLUDED.expires_at,source=EXCLUDED.source,
      windows_json=CASE WHEN o.expires_at>statement_timestamp() THEN o.windows_json ELSE NULL END,
      account_json=EXCLUDED.account_json
      WHERE EXCLUDED.observed_at>=o.observed_at
    RETURNING to_json(expires_at)#>>'{}' AS expires_at`,
  values: [input.ownerUserId, quotaPoolId, Number.isFinite(reset) ? new Date(reset).toISOString() : null], maxRows: 1 });
  const limitedUntil = rows[0] ? new Date(String(rows[0].expires_at)).toISOString() : undefined;
  if (rows[0]) await recordPoolReconciliationTransition(tx, input.ownerUserId, quotaPoolId, false);
  // A daemon that predates scopes sends neither a scope, a reason, nor a
  // complete reading, which means the whole account is used up.
  const scopeAware = Boolean(scope || scopeReason || record?.scoped);
  return { quotaPoolId, ...(limitedUntil ? { limitedUntil } : {}),
    usedUp: !scopeAware || scope === ACCOUNT_QUOTA_SCOPE ? "account" : "unresolved" };
}

/** Clear an active account billing-refusal hold, and any scoped billing holds
 * matching `scopes`, when a Run on this registration replies successfully. */
export async function clearRegistrationAccountHold(directory: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string; harness: string; scopes?: readonly string[];
}): Promise<boolean> {
  const scopes = [...new Set((input.scopes ?? []).map(scope => scope.trim().toLowerCase()).filter(Boolean))];
  return directory.transaction({ requestId: input.requestId, operation: "registration.account-hold.clear" }, async tx => {
    const [pool] = await tx.query<QueryResultRow>({ name: "registration_account_hold_pool_v1", text: `SELECT
        ${REGISTRATION_QUOTA_POOL_SQL} AS quota_pool_id FROM control.agent_registration_environments e
      WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=$3`,
    values: [input.ownerUserId, input.machineId, input.harness], maxRows: 1 });
    if (pool) {
      await lockRegistrationQuotaPools(tx, [{ ownerUserId: input.ownerUserId, quotaPoolId: String(pool.quota_pool_id) }]);
    }
    const rows = await tx.query<QueryResultRow>({ name: "registration_account_hold_clear_v1", text: `DELETE FROM
        control.registration_quota_observations o
      USING control.agent_registration_environments e
      WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=$3
        AND o.owner_user_id=e.owner_user_id
        AND o.quota_pool_id=${REGISTRATION_QUOTA_POOL_SQL}
        AND o.source='daemon'
        AND COALESCE((o.account_json->>'billingRefusal')::boolean,FALSE)
      RETURNING o.quota_pool_id`,
    values: [input.ownerUserId, input.machineId, input.harness], maxRows: 1 });
    let cleared = Boolean(rows[0]);
    if (scopes.length) {
      const scopedRows = await tx.query<QueryResultRow>({ name: "registration_scoped_billing_hold_clear_v1", text: `WITH kept AS (
          SELECT o.owner_user_id,o.quota_pool_id,
            (SELECT jsonb_object_agg(kv.key,kv.value)
              FROM jsonb_each(o.account_json->'billingRefusalScopes') kv
              WHERE lower(btrim(kv.key))<>ALL($4::text[])) AS remaining_scopes,
            o.account_json-'billingRefusalScopes' AS base_account
          FROM control.registration_quota_observations o
          JOIN control.agent_registration_environments e
            ON o.owner_user_id=e.owner_user_id AND o.quota_pool_id=${REGISTRATION_QUOTA_POOL_SQL}
          WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=$3
            AND o.account_json ? 'billingRefusalScopes'
            AND jsonb_typeof(o.account_json->'billingRefusalScopes')='object'
            AND EXISTS (SELECT 1 FROM jsonb_object_keys(o.account_json->'billingRefusalScopes') k
              WHERE lower(btrim(k))=ANY($4::text[]))
          FOR UPDATE OF o
        )
        UPDATE control.registration_quota_observations o
        SET account_json=CASE
          WHEN kept.remaining_scopes IS NOT NULL
            THEN kept.base_account||jsonb_build_object('billingRefusalScopes',kept.remaining_scopes)
          WHEN kept.base_account='{}'::jsonb THEN NULL
          ELSE kept.base_account END
        FROM kept
        WHERE o.owner_user_id=kept.owner_user_id AND o.quota_pool_id=kept.quota_pool_id
        RETURNING o.quota_pool_id`,
      values: [input.ownerUserId, input.machineId, input.harness, scopes], maxRows: 1 });
      cleared = cleared || Boolean(scopedRows[0]);
    }
    return cleared;
  });
}
