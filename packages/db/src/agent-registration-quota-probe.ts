import { currentRoutingQuotaWindows, digestCanonicalCloneCborV1, parseLlmQuotaAccount, quotaAccountBalance,
  routingQuotaAccountPartExpiry, routingQuotaObservation, routingQuotaProbeObservations, routingQuotaRecord,
  routingQuotaUsageWindows, type AgentRegistrationLiveState, type LlmQuotaAccount, type LlmUsage,
  type RoutingModelOption, type RoutingQuotaProbeRequest, type RoutingQuotaRecord,
  type RoutingQuotaWindow } from "@xmatrix/protocol";
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

/** Whether the pool reading `alias` is current: its account part or its
 * scoped part still counts (see migration 0254). */
export function currentRegistrationQuotaSql(alias: string): string {
  return `${alias}.observed_at<=statement_timestamp() AND (${alias}.expires_at>statement_timestamp()
    OR ${alias}.scoped_expires_at>statement_timestamp())`;
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

/** A stored pool reading in usage form: account windows and the scoped
 * windows with their own read time. Readers derive any model's headroom from
 * it with `routingQuotaObservation`. */
export type RegistrationQuotaUsage = LlmUsage & { scopedQuotaObservedAt?: string };

const time = (value: unknown) => value instanceof Date ? value.getTime()
  : typeof value === "string" ? Date.parse(value) : NaN;

/** The pool reading of a row of `registrationQuotaColumns`, or none when
 * neither part counts at `now`. A windowless usage-limit hold
 * (`source='daemon'`) reads as one used-up account window until it ends. */
export function registrationQuotaUsage(row: Record<string, unknown> | undefined, now = Date.now()):
  RegistrationQuotaUsage | undefined {
  const observed = time(row?.observed_at), expires = time(row?.expires_at);
  const scopedObserved = time(row?.scoped_observed_at), scopedExpires = time(row?.scoped_expires_at);
  if (!row || !Number.isFinite(observed) || observed > now) return undefined;
  const accountCurrent = expires > now;
  const scopedCurrent = scopedObserved <= now && scopedExpires > now;
  if (!accountCurrent && !scopedCurrent) return undefined;
  const hold = row.source === "daemon";
  const quotaAccount = accountCurrent && !hold ? parseLlmQuotaAccount(row.account_json) : undefined;
  const quotaUsages = !accountCurrent ? [] : hold
    ? [{ percent: 100 - Number(row.remaining), resetAt: new Date(expires).toISOString() }]
    : routingQuotaUsageWindows(currentRoutingQuotaWindows(row.windows_json, now));
  return { quotaSource: "provider_api", quotaObservedAt: new Date(observed).toISOString(), quotaUsages,
    ...(scopedCurrent ? { scopedQuotaUsages: routingQuotaUsageWindows(currentRoutingQuotaWindows(row.scoped_windows_json, now)),
      scopedQuotaObservedAt: new Date(scopedObserved).toISOString() } : {}),
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

/** The headroom shown for a pool: the account's own, or, when no account
 * window counts, that of its least used scope (the best model it can run). */
export function registrationShownQuotaReading(row: Record<string, unknown> | undefined):
  ReturnType<typeof registrationQuotaReading> {
  const account = registrationQuotaReading(row);
  if (account) return account;
  const scopes = new Set((registrationQuotaUsage(row)?.scopedQuotaUsages ?? []).flatMap(window =>
    window.scope ? [window.scope] : []));
  return [...scopes].flatMap(scope => registrationQuotaReading(row, { quotaScopes: [scope] }) ?? [])
    .sort((left, right) => right.remainingPercent - left.remainingPercent)[0];
}

/** Every window of a current pool reading as shown: its account windows, then
 * its scoped ones (each with its scope). */
export function registrationQuotaWindows(row: Record<string, unknown> | undefined, now = Date.now()): RoutingQuotaWindow[] {
  const usage = registrationQuotaUsage(row, now);
  if (!usage) return [];
  const account = time(row?.expires_at) > now ? currentRoutingQuotaWindows(row?.windows_json, now) : [];
  return [...account, ...usage.scopedQuotaUsages ? currentRoutingQuotaWindows(row?.scoped_windows_json, now) : []];
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
    name: "registration_quota_probe_daemons_v8", text: `SELECT requested.owner,requested.machine,requested.harness,
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
      WHERE $3::boolean IS NOT TRUE OR q.owner_user_id IS NULL OR ${UNREAD_HOLD_SQL}
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

/** How far apart a refusal's reset and a window's reset may lie and still
 * name the same window: the provider states whole seconds in one place and
 * the instant it computed in another (the daemon matches the same way). */
const QUOTA_RESET_MATCH_MS = 2_000;

/** `account`: a usage limit used up an account window. */
export const ACCOUNT_QUOTA_SCOPE = "account";
/** The daemon could not tell which window a usage limit used up. */
export const UNRESOLVED_QUOTA_SCOPE = "unresolved";

/**
 * The reading with the window that resets at `resetsAt` read as used up, or
 * none when the reading does not tell which window that is: a refusal names
 * the window it used up by its reset, whatever share the reading rounds it
 * to. `scope` narrows the match to the account windows (`account`) or to one
 * scope's windows; without it any window counts. Several windows resetting
 * then (an account week and a model week at the same instant) tell it only
 * when one of them already reads used up; marking them all would stop the
 * whole account for one model.
 */
export function quotaRecordUsedUp(record: RoutingQuotaRecord, resetsAt: number, scope: string | undefined,
  now: number): RoutingQuotaRecord | undefined {
  const matches = (window: RoutingQuotaWindow, scoped: boolean) =>
    (scope === undefined || (scope === ACCOUNT_QUOTA_SCOPE ? !scoped
      : scoped && window.scope?.toLowerCase() === scope.toLowerCase()))
    && window.resetAt !== undefined && Math.abs(Date.parse(window.resetAt) - resetsAt) <= QUOTA_RESET_MATCH_MS;
  const candidates = [...record.windows.filter(window => matches(window, false)),
    ...(record.scoped?.windows ?? []).filter(window => matches(window, true))];
  const sole = candidates.length === 1 ? candidates[0] : undefined;
  if (!sole && !candidates.some(window => window.usedPercent >= 100)) return undefined;
  const mark = (windows: readonly RoutingQuotaWindow[]) =>
    windows.map(window => window === sole ? { ...window, usedPercent: 100 } : window);
  const windows = mark(record.windows);
  const scoped = record.scoped ? mark(record.scoped.windows) : undefined;
  return routingQuotaRecord({ quotaSource: "provider_api", quotaObservedAt: record.observedAt,
    quotaUsages: routingQuotaUsageWindows(windows),
    ...(scoped ? { scopedQuotaUsages: routingQuotaUsageWindows(scoped) } : {}),
    ...(record.quotaAccount ? { quotaAccount: record.quotaAccount } : {}) }, now);
}

/** `column=new` where `condition` holds, else the stored value. `values`
 * maps a column to what replaces it (`EXCLUDED.column` by default). */
const setWhen = (condition: string, columns: readonly string[], values: Record<string, string> = {}) =>
  columns.map(column => `${column}=CASE WHEN ${condition} THEN ${values[column] ?? `EXCLUDED.${column}`}
    ELSE o.${column} END`).join(",");
/** The account part of a stored reading is replaced by a newer reading, but a
 * windowless usage-limit hold only by a reading that explains it ($11: one of
 * its windows resets when the hold ends) or once it ends. */
const ACCOUNT_PART_NEWER = `EXCLUDED.observed_at>=o.observed_at AND (o.source<>'daemon'
  OR o.expires_at<=statement_timestamp() OR $11::boolean)`;
/** The scoped part only by a newer complete reading. */
const SCOPED_PART_NEWER = `EXCLUDED.scoped_observed_at>=COALESCE(o.scoped_observed_at,'-infinity'::timestamptz)`;

/**
 * The new windows of one part (`incoming`), each keeping the larger share
 * used of itself and the same window as stored (`stored`: the same scope,
 * or both account windows, the same label, a reset within
 * QUOTA_RESET_MATCH_MS). A window read used up (a refusal said so) is not
 * reopened by a later reading that rounds or lags it below 100%; its reset
 * moves its `resetAt`, which makes it another window.
 */
const keptWindows = (incoming: string, stored: string) => `COALESCE((SELECT jsonb_agg(CASE
    WHEN kept.used>(n->>'usedPercent')::float8 THEN jsonb_set(n,'{usedPercent}',to_jsonb(kept.used)) ELSE n END
    ORDER BY n_at)
  FROM jsonb_array_elements(${incoming}) WITH ORDINALITY AS fresh(n,n_at)
  LEFT JOIN LATERAL (SELECT max((p->>'usedPercent')::float8) AS used
    FROM jsonb_array_elements(COALESCE(${stored},'[]'::jsonb)) p
    WHERE p->>'label' IS NOT DISTINCT FROM n->>'label' AND p->>'scope' IS NOT DISTINCT FROM n->>'scope'
      AND n ? 'resetAt' AND p ? 'resetAt' AND abs(extract(epoch FROM
        (p->>'resetAt')::timestamptz-(n->>'resetAt')::timestamptz))*1000<=${QUOTA_RESET_MATCH_MS}) kept ON TRUE),
  ${incoming})`;
/** When a part with these windows stops counting: as read, or later when a
 * kept used-up window holds it until its reset (31 days at most). */
const keptExpiry = (expires: string, windows: string, observed: string) => `GREATEST(${expires},
  (SELECT max(LEAST((w->>'resetAt')::timestamptz,${observed}+interval '31 days')) FROM jsonb_array_elements(
    COALESCE(${windows},'[]'::jsonb)) w WHERE (w->>'usedPercent')::float8>=100 AND w ? 'resetAt'
      AND (w->>'resetAt')::timestamptz>${observed}))`;
const KEPT_ACCOUNT_WINDOWS = keptWindows("EXCLUDED.windows_json", "o.windows_json");
const KEPT_SCOPED_WINDOWS = keptWindows("EXCLUDED.scoped_windows_json", "o.scoped_windows_json");
/** The account's headroom as the kept windows leave it: the reading's own
 * (`EXCLUDED.remaining`, the provider's verdict included) lowered by a window
 * kept used up, never below the floor a still-served account keeps ($12). */
const KEPT_REMAINING = `GREATEST(LEAST(EXCLUDED.remaining,COALESCE(100-(SELECT max((w->>'usedPercent')::float8)
  FROM jsonb_array_elements(${KEPT_ACCOUNT_WINDOWS}) w),100)),$12::float8)`;

/** Persist one owner's provider reading, each part fenced on its own read
 * time: every reading renews the account part, a complete one the scoped part
 * too. A reading never replaces a newer one, and one already expired is not
 * written. A complete reading over a windowless usage-limit hold that shows
 * the window resetting when the hold ends reads it as the one used up
 * (`quotaRecordUsedUp`) and replaces the hold; one that shows none leaves the
 * hold until it ends. */
export async function upsertRegistrationQuotaObservation(tx: DatabaseTransaction, input: {
  ownerUserId: string; quotaPoolId: string; record: RoutingQuotaRecord;
}): Promise<boolean> {
  let record = input.record;
  let explainsHold = false;
  if (record.scoped) {
    const [hold] = await tx.query<QueryResultRow>({ name: "registration_quota_hold_v1", text: `SELECT
        to_json(expires_at)#>>'{}' AS held_until FROM control.registration_quota_observations
      WHERE owner_user_id=$1 AND quota_pool_id=$2 AND source='daemon' AND expires_at>statement_timestamp()
        AND observed_at<=$3::timestamptz FOR UPDATE`,
    values: [input.ownerUserId, input.quotaPoolId, record.observedAt], maxRows: 1 });
    const narrowed = hold ? quotaRecordUsedUp(record, Date.parse(String(hold.held_until)), undefined, Date.now()) : undefined;
    if (narrowed) { record = narrowed; explainsHold = true; }
  }
  await tx.query({ name: "registration_quota_observe_v7", text: `INSERT INTO control.registration_quota_observations AS o
      (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,windows_json,account_json,
        scoped_windows_json,scoped_observed_at,scoped_expires_at)
      SELECT $1,$2,$3,$4::timestamptz,$5::timestamptz,'provider',$6::jsonb,$7::jsonb,$8::jsonb,$9::timestamptz,$10::timestamptz
      WHERE $4::timestamptz<=statement_timestamp() AND GREATEST($5::timestamptz,$10::timestamptz)>statement_timestamp()
      ON CONFLICT (owner_user_id,quota_pool_id) DO UPDATE SET
        ${setWhen(ACCOUNT_PART_NEWER, ["remaining", "observed_at", "expires_at", "source", "windows_json", "account_json"], {
          windows_json: KEPT_ACCOUNT_WINDOWS, remaining: KEPT_REMAINING,
          expires_at: keptExpiry("EXCLUDED.expires_at", KEPT_ACCOUNT_WINDOWS, "EXCLUDED.observed_at") })},
        ${setWhen(SCOPED_PART_NEWER, ["scoped_windows_json", "scoped_observed_at", "scoped_expires_at"], {
          scoped_windows_json: KEPT_SCOPED_WINDOWS,
          scoped_expires_at: keptExpiry("EXCLUDED.scoped_expires_at", KEPT_SCOPED_WINDOWS, "EXCLUDED.scoped_observed_at") })}
      WHERE (${ACCOUNT_PART_NEWER}) OR ${SCOPED_PART_NEWER}`,
    values: [input.ownerUserId, input.quotaPoolId, record.account?.value ?? 100, record.observedAt,
      routingQuotaAccountPartExpiry(record), record.windows.length ? JSON.stringify(record.windows) : null,
      record.quotaAccount ? JSON.stringify(record.quotaAccount) : null,
      record.scoped ? JSON.stringify(record.scoped.windows) : null, record.scoped ? record.observedAt : null,
      record.scoped?.expiresAt ?? null, explainsHold, record.quotaAccount?.allowed === true ? 1 : 0],
    maxRows: 0 });
  // A reading may end a refused summon's wait. Marking it here, in the
  // reading's own transaction, means the event cannot be lost. True when one
  // of the owner's waits is ready to deliver. A used-up account rings nobody;
  // the waits read the stored reading, kept windows included.
  return (record.account?.value ?? 100) > 0 && await markRegistrationQuotaWaitersReady(tx, input.ownerUserId);
}


/** How many of one owner's waits one reading looks at. */
const QUOTA_WAITERS_PER_OWNER = 128;

/**
 * Inside a transaction that recorded a reading of `ownerUserId`'s quota or a
 * wait: every wait of the owner's whose pool now has a current reading newer
 * than the one that refused it, whose account is not used up, becomes ready.
 * A wait is a doorbell: the retry it rings reads the headroom of its own
 * model. True when any wait of the owner is ready.
 */
export async function markRegistrationQuotaWaitersReady(tx: DatabaseTransaction, ownerUserId: string): Promise<boolean> {
  const waits = await tx.query<QueryResultRow>({ name: "registration_quota_waiters_pending_v2", text: `SELECT
      w.quota_pool_id,w.channel_id,w.ready_at IS NOT NULL AS ready,${registrationQuotaColumns("q")}
    FROM control.registration_quota_waiters w
    LEFT JOIN control.registration_quota_observations q ON q.owner_user_id=w.owner_user_id
      AND q.quota_pool_id=w.quota_pool_id AND q.observed_at>w.refused_through AND ${currentRegistrationQuotaSql("q")}
    WHERE w.owner_user_id=$1 AND w.expires_at>statement_timestamp()
    ORDER BY w.quota_pool_id,w.channel_id LIMIT ${QUOTA_WAITERS_PER_OWNER}`,
  values: [ownerUserId], maxRows: QUOTA_WAITERS_PER_OWNER });
  const ready = waits.filter(row => row.ready !== true && row.observed_at != null
    && (registrationQuotaReading(row)?.remainingPercent ?? 100) > 0);
  if (ready.length) {
    await tx.query({ name: "registration_quota_waiters_ready_v1", text: `UPDATE control.registration_quota_waiters w
        SET ready_at=clock_timestamp(),ready_token=gen_random_uuid()
        FROM jsonb_to_recordset($2::jsonb) AS woken(pool text,channel text)
      WHERE w.owner_user_id=$1 AND w.quota_pool_id=woken.pool AND w.channel_id=woken.channel AND w.ready_at IS NULL`,
    values: [ownerUserId, JSON.stringify(ready.map(row => ({ pool: String(row.quota_pool_id),
      channel: String(row.channel_id) })))], maxRows: 0 });
  }
  return ready.length > 0 || waits.some(row => row.ready === true);
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
  ownerUserId: string; machineId: string; harness: string; resetsAt?: string; quotaScope?: string; usage?: unknown;
}): Promise<RegistrationUsageLimit | undefined> {
  const now = Date.now();
  const reset = input.resetsAt ? Date.parse(input.resetsAt) : NaN;
  const [pool] = await tx.query<QueryResultRow>({ name: "registration_usage_limit_pool_v1", text: `SELECT
      ${REGISTRATION_QUOTA_POOL_SQL} AS quota_pool_id FROM control.agent_registration_environments e
    WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=$3`,
  values: [input.ownerUserId, input.machineId, input.harness], maxRows: 1 });
  if (!pool) return undefined;
  const quotaPoolId = String(pool.quota_pool_id);
  const record = input.usage === undefined ? undefined : routingQuotaRecord(input.usage, now);
  const scope = input.quotaScope?.trim();
  const usedUp = scope && scope !== UNRESOLVED_QUOTA_SCOPE && record?.scoped && Number.isFinite(reset)
    ? quotaRecordUsedUp(record, reset, scope, now) : undefined;
  if (usedUp) {
    await upsertRegistrationQuotaObservation(tx, { ownerUserId: input.ownerUserId, quotaPoolId, record: usedUp });
    const limitedUntil = new Date(reset).toISOString();
    return scope === ACCOUNT_QUOTA_SCOPE ? { quotaPoolId, limitedUntil, usedUp: "account" }
      : { quotaPoolId, limitedUntil, usedUp: "scope", scope: scope! };
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
  // A daemon that predates scopes reports the account used up, as before.
  return { quotaPoolId, ...(limitedUntil ? { limitedUntil } : {}),
    usedUp: scope === undefined || scope === "" || scope === ACCOUNT_QUOTA_SCOPE ? "account" : "unresolved" };
}
