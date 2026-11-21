import { utf8ByteLength } from "./hex.js";
import { clampRoutingQuotaObservedTime, ROUTING_QUOTA_MAX_AGE_MS, routingQuotaObservation, routingQuotaResetTime,
  routingScopedQuotaExpiry, type RoutingObservation } from "./agent-routing.js";
import { parseLlmQuotaAccount, quotaAccountBalance, type LlmQuotaAccount } from "./authority-runtime.js";

/** A bounded read of already registered environments, never a launch or an access grant.
 * `targetId` names the harness to read (`registration:<harness>`). */
export interface RoutingQuotaProbeTarget {
  targetId: string;
  /** Server-frozen configuration digest; changing configuration invalidates the response. */
  configurationDigest: string;
}

export interface RoutingQuotaProbeRequest {
  requestId: string;
  connectionEpoch: number;
  targets: RoutingQuotaProbeTarget[];
  /** Asks the daemon to name each window (`5h`, `1w`). A daemon that predates
   * it ignores the field and answers unnamed windows, which stay valid; a
   * named window is accepted only when the probe asked for names. */
  windowLabels?: true;
  /** Asks the daemon for the provider's verdict on the account (`allowed`,
   * credits). A daemon that predates it ignores the field; a result carrying
   * it is accepted only when the probe asked. */
  quotaAccount?: true;
  /** Asks the daemon to read the provider now rather than answer from its
   * own recent reading: the probe checks a refusal, so only a reading newer
   * than the one that refused can change anything. A daemon that predates it
   * ignores the field and may answer from its cache. */
  fresh?: true;
  /** Accepts an observed result with no windows: a prepaid account, read as
   * its balance and currency alone. Only with `quotaAccount`. A daemon that
   * predates it ignores the field and reports such a harness unsupported. */
  accountBalance?: true;
  /** Asks for the windows that constrain only some models (`scopedQuotaUsages`,
   * each with its `scope`), which may then be a result's only windows. A
   * daemon that predates it ignores the field and answers account windows. */
  scopedQuotaUsages?: true;
}

export interface RoutingQuotaProbeWindow {
  percent: number;
  resetAt?: string;
  /** The provider's name for the window, only when the probe asked for it. */
  label?: string;
  /** What a scoped window constrains (`Fable`, `Auto`); scoped windows only. */
  scope?: string;
}

/** One provider window as it is shown: share used and when it resets. */
export interface RoutingQuotaWindow {
  label?: string;
  usedPercent: number;
  /** ISO-8601 instant the window resets. */
  resetAt?: string;
  /** A scoped window's scope; an account window has none. */
  scope?: string;
}

export const ROUTING_QUOTA_MAX_WINDOWS = 8;
/** The longest scope a scoped window may name, in UTF-8 bytes. */
export const ROUTING_QUOTA_MAX_SCOPE_BYTES = 64;

export type RoutingQuotaProbeResult = RoutingQuotaProbeTarget & (
  | { status: "observed"; quotaSource: "provider_api"; quotaObservedAt: string;
      quotaUsages: RoutingQuotaProbeWindow[]; scopedQuotaUsages?: RoutingQuotaProbeWindow[];
      quotaAccount?: LlmQuotaAccount }
  | { status: "unavailable"; reason: "unsupported" | "configuration_unavailable" | "provider_unavailable" | "timeout" }
);

export interface RoutingQuotaProbeResponse {
  requestId: string;
  connectionEpoch: number;
  results: RoutingQuotaProbeResult[];
}

export const ROUTING_QUOTA_PROBE_MAX_TARGETS = 32;

/**
 * One provider reading as it is stored: its account part, renewed by every
 * reading, and its scoped part, renewed only by a complete one (one that
 * states its scoped windows, even as none). Each part keeps the windows that
 * still count and until when the last of them does.
 */
export interface RoutingQuotaRecord {
  observedAt: string;
  /** The account's own headroom (its account windows, or a prepaid balance),
   * absent when none counts. */
  account?: RoutingObservation<number>;
  windows: RoutingQuotaWindow[];
  quotaAccount?: LlmQuotaAccount;
  /** Present on a complete reading only. */
  scoped?: { windows: RoutingQuotaWindow[]; expiresAt?: string };
}

/** A reading (an Instance's usage, a probe result) as it is stored, or none
 * when it is not a provider read or nothing of it counts at `now`. */
export function routingQuotaRecord(usage: unknown, now: number): RoutingQuotaRecord | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const row = usage as Record<string, unknown>;
  const observed = clampRoutingQuotaObservedTime(
    typeof row.quotaObservedAt === "string" ? Date.parse(row.quotaObservedAt) : NaN, now);
  if (row.quotaSource !== "provider_api" || observed === undefined) return undefined;
  const account = routingQuotaObservation(usage, now);
  const complete = Array.isArray(row.scopedQuotaUsages);
  const scopedExpiresAt = complete ? routingScopedQuotaExpiry(usage, now) : undefined;
  if (!account && !scopedExpiresAt) return undefined;
  const quotaAccount = parseLlmQuotaAccount(row.quotaAccount);
  return { observedAt: new Date(observed).toISOString(), ...(account ? { account } : {}),
    windows: currentRoutingQuotaWindows(usageWindows(row.quotaUsages, false), now),
    ...(quotaAccount ? { quotaAccount } : {}),
    ...(complete ? { scoped: { windows: currentRoutingQuotaWindows(usageWindows(row.scopedQuotaUsages, true), now),
      ...(scopedExpiresAt ? { expiresAt: scopedExpiresAt } : {}) } } : {}) };
}

/**
 * Translates the pre-scope Cursor wire. A daemon from before quota scopes
 * (#1693) reports Cursor's Auto and API pools as account windows labelled
 * `Auto` and `API` beside the `1mo` cycle total, and never sends the
 * `scopedQuotaUsages` field, which a later daemon's complete reading always
 * carries (even empty): its absence marks the old protocol. Under that
 * protocol the pools constrained models by pool and the total gated nothing,
 * so the pools become scoped windows `Auto` and `API` and the total is
 * dropped. Any other reading, and every reading carrying the field, is
 * returned as is. Delete this once no daemon below the #1693 release reports.
 */
export function fromPreScopeCursorWire(usage: unknown, harness: string): unknown {
  if (harness !== "cursor" || !usage || typeof usage !== "object" || Array.isArray(usage)) return usage;
  const row = usage as Record<string, unknown>;
  if ("scopedQuotaUsages" in row || !Array.isArray(row.quotaUsages)) return usage;
  const pool = (window: unknown) => {
    const label = window && typeof window === "object" ? (window as Record<string, unknown>).label : undefined;
    return label === "Auto" || label === "API" ? label : undefined;
  };
  const pools = row.quotaUsages.filter(pool);
  if (!pools.length) return usage;
  return { ...row, quotaUsages: [],
    scopedQuotaUsages: pools.map(window => ({ ...window as Record<string, unknown>, scope: pool(window) })) };
}

/** Windows of a usage or probe reading (`percent`) in their shown form (`usedPercent`). */
function usageWindows(value: unknown, scoped: boolean): unknown[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const { label, window, percent, resetAt, reset_at, scope } = item as Record<string, unknown>;
    if (scoped && (typeof scope !== "string" || !scope.trim())) return [];
    return [{ label: label ?? window, usedPercent: percent, resetAt: resetAt ?? reset_at, ...(scoped ? { scope } : {}) }];
  });
}

/** How long an account part with no window counts: a reading saying the
 * account has none (Cursor with Auto and API pools) is still a reading. */
export function routingQuotaAccountPartExpiry(record: RoutingQuotaRecord): string {
  return record.account?.expiresAt ?? new Date(Date.parse(record.observedAt) + ROUTING_QUOTA_MAX_AGE_MS).toISOString();
}

/** Only server-bound targets can become quota facts. Unavailable/expired reads
 * yield no write: they cannot erase a prior exhausted observation or become 0%
 * used. The caller owns authenticated target/pool resolution and persistence. */
export function routingQuotaProbeObservations(value: unknown, expected: RoutingQuotaProbeRequest,
  now: number): Array<RoutingQuotaProbeTarget & { record: RoutingQuotaRecord }> {
  const response = parseRoutingQuotaProbeResponse(value, expected, now);
  return response.results.flatMap(result => {
    if (result.status !== "observed") return [];
    const harness = result.targetId.startsWith("registration:") ? result.targetId.slice("registration:".length) : "";
    const record = routingQuotaRecord(fromPreScopeCursorWire(result, harness), now);
    return record ? [{ targetId: result.targetId, configurationDigest: result.configurationDigest, record }] : [];
  });
}

/** The windows of a reading, however it arrived (a probe, a stored row, a
 * catalog response), that still count at `now`: a window whose reset time has
 * passed is gone, and one without a readable reset time is kept without one. */
export function currentRoutingQuotaWindows(value: unknown, now: number): RoutingQuotaWindow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RoutingQuotaWindow[] => {
    if (!item || typeof item !== "object") return [];
    const { label, usedPercent, resetAt, scope } = item as Record<string, unknown>;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return [];
    const reset = routingQuotaResetTime(resetAt);
    if (Number.isFinite(reset) && reset <= now) return [];
    return [{ ...(typeof label === "string" && label ? { label } : {}), usedPercent,
      ...(Number.isFinite(reset) ? { resetAt: new Date(reset).toISOString() } : {}),
      ...(typeof scope === "string" && scope ? { scope } : {}) }];
  }).slice(0, ROUTING_QUOTA_MAX_WINDOWS);
}

/** A stored reading's windows back in usage form (`percent`), for `routingQuotaObservation`. */
export function routingQuotaUsageWindows(windows: readonly RoutingQuotaWindow[]) {
  return windows.map(({ usedPercent, ...window }) => ({ ...window, percent: usedPercent }));
}

const QUOTA_WINDOW_UNIT_MS: Record<string, number> = {
  m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, mo: 30 * 86_400_000 };

/** A window's length from its label (`5h`, `1w`, `1mo`), NaN when the label names none. */
function routingQuotaWindowLength(label: string | undefined): number {
  const match = /^(\d+)(mo|m|h|d|w)$/u.exec((label ?? "").trim().toLowerCase());
  return match ? Number(match[1]) * QUOTA_WINDOW_UNIT_MS[match[2]!]! : NaN;
}

/**
 * How fast an account may spend against its provider's pace: each account
 * window's remaining share divided by the share of that window still to run
 * before it resets. At 1 the window is spent exactly by its reset; above 1
 * what is left is lost at the reset unless it is used, so it is the cheaper
 * quota to spend; below 1 it runs out first. Every window caps spending, so
 * the tightest one counts. A window with no known length or reset counts its
 * remaining share alone. Scoped windows constrain single models, not the
 * account, and are not read here.
 *
 * `remainingPercent` is the provider's verdict on the whole account: none left
 * is no pace, and an account served past its windows (credits) keeps that
 * small share instead of the windows' zero.
 */
export function routingQuotaPace(quota: { remainingPercent: number; windows?: readonly RoutingQuotaWindow[] },
  now: number): number {
  if (!(quota.remainingPercent > 0)) return 0;
  const paces = currentRoutingQuotaWindows(quota.windows ?? [], now).filter(window => !window.scope).map(window => {
    const remaining = (100 - window.usedPercent) / 100;
    const reset = window.resetAt ? Date.parse(window.resetAt) : NaN;
    const length = routingQuotaWindowLength(window.label);
    if (!Number.isFinite(reset) || !Number.isFinite(length)) return remaining;
    return remaining / Math.min(1, (reset - now) / length);
  });
  const windowsPace = paces.length ? Math.min(...paces) : undefined;
  return windowsPace === undefined || windowsPace === 0 ? quota.remainingPercent / 100 : windowsPace;
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid quota probe object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !allowed.includes(key))) throw new Error("Unexpected quota probe field");
  return row;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      utf8ByteLength(value) > maximum) throw new Error("Invalid quota probe text");
  return value;
}

function target(row: Record<string, unknown>): RoutingQuotaProbeTarget {
  const targetId = text(row.targetId, 300);
  if (typeof row.configurationDigest !== "string" || !/^[a-f0-9]{64}$/u.test(row.configurationDigest)) {
    throw new Error("Invalid quota probe configuration digest");
  }
  return { targetId, configurationDigest: row.configurationDigest };
}

export function parseRoutingQuotaProbeRequest(value: unknown): RoutingQuotaProbeRequest {
  const row = record(value, ["requestId", "connectionEpoch", "targets", "windowLabels", "quotaAccount", "fresh",
    "accountBalance", "scopedQuotaUsages"]);
  if (row.accountBalance !== undefined && (row.accountBalance !== true || row.quotaAccount !== true)) {
    throw new Error("Invalid quota probe balance request");
  }
  if (row.windowLabels !== undefined && row.windowLabels !== true) throw new Error("Invalid quota probe window labels");
  if (row.quotaAccount !== undefined && row.quotaAccount !== true) throw new Error("Invalid quota probe account request");
  if (row.fresh !== undefined && row.fresh !== true) throw new Error("Invalid quota probe freshness");
  if (row.scopedQuotaUsages !== undefined && row.scopedQuotaUsages !== true) {
    throw new Error("Invalid quota probe scoped windows request");
  }
  const requestId = text(row.requestId, 200);
  if (!Number.isSafeInteger(row.connectionEpoch) || Number(row.connectionEpoch) < 1) {
    throw new Error("Invalid quota probe epoch");
  }
  if (!Array.isArray(row.targets) || !row.targets.length || row.targets.length > ROUTING_QUOTA_PROBE_MAX_TARGETS) {
    throw new Error("Invalid quota probe target count");
  }
  const targets = row.targets.map(value => target(record(value, ["targetId", "configurationDigest"])));
  if (new Set(targets.map(item => item.targetId)).size !== targets.length) throw new Error("Duplicate quota probe target");
  return { requestId, connectionEpoch: Number(row.connectionEpoch), targets,
    ...(row.windowLabels === true ? { windowLabels: true as const } : {}),
    ...(row.quotaAccount === true ? { quotaAccount: true as const } : {}),
    ...(row.fresh === true ? { fresh: true as const } : {}),
    ...(row.accountBalance === true ? { accountBalance: true as const } : {}),
    ...(row.scopedQuotaUsages === true ? { scopedQuotaUsages: true as const } : {}) };
}

/** Windows of one probe result: account windows, or (`scoped`) windows that
 * each name their scope. */
function probeWindows(value: unknown, labels: boolean, scoped: boolean): RoutingQuotaProbeWindow[] {
  if (!Array.isArray(value) || value.length > ROUTING_QUOTA_MAX_WINDOWS) throw new Error("Invalid quota probe window count");
  return value.map((item): RoutingQuotaProbeWindow => {
    const window = record(item, ["percent", "resetAt", ...(labels || scoped ? ["label"] : []), ...(scoped ? ["scope"] : [])]);
    if (typeof window.percent !== "number" || !Number.isFinite(window.percent) ||
        window.percent < 0 || window.percent > 100) throw new Error("Invalid quota probe percentage");
    return { percent: window.percent,
      ...(window.resetAt === undefined ? {} : { resetAt: text(window.resetAt, 40) }),
      ...(window.label === undefined ? {} : { label: text(window.label, 24) }),
      ...(scoped ? { scope: text(window.scope, ROUTING_QUOTA_MAX_SCOPE_BYTES) } : {}) };
  });
}

/** Validate at the authenticated daemon boundary; no caller-supplied owner or account identity is accepted. */
export function parseRoutingQuotaProbeResponse(value: unknown, expected: RoutingQuotaProbeRequest,
  now: number): RoutingQuotaProbeResponse {
  const request = parseRoutingQuotaProbeRequest(expected);
  if (!Number.isFinite(now)) throw new Error("Invalid quota probe clock");
  const row = record(value, ["requestId", "connectionEpoch", "results"]);
  if (row.requestId !== request.requestId || row.connectionEpoch !== request.connectionEpoch) {
    throw new Error("Quota probe request or epoch mismatch");
  }
  if (!Array.isArray(row.results) || row.results.length !== request.targets.length) {
    throw new Error("Incomplete quota probe response");
  }
  const unseen = new Map(request.targets.map(item => [item.targetId, item.configurationDigest]));
  const results = row.results.map((value): RoutingQuotaProbeResult => {
    const result = record(value, ["targetId", "configurationDigest", "status", "reason",
      "quotaSource", "quotaObservedAt", "quotaUsages", ...(request.quotaAccount ? ["quotaAccount"] : []),
      ...(request.scopedQuotaUsages ? ["scopedQuotaUsages"] : [])]);
    const identity = target(result);
    if (unseen.get(identity.targetId) !== identity.configurationDigest) throw new Error("Quota probe target mismatch");
    unseen.delete(identity.targetId);
    if (result.status === "unavailable") {
      if (!["unsupported", "configuration_unavailable", "provider_unavailable", "timeout"].includes(String(result.reason)) ||
          "quotaSource" in result || "quotaObservedAt" in result || "quotaUsages" in result || "quotaAccount" in result ||
          "scopedQuotaUsages" in result) {
        throw new Error("Invalid unavailable quota probe result");
      }
      return { ...identity, status: "unavailable", reason: result.reason as Extract<RoutingQuotaProbeResult,
        { status: "unavailable" }>["reason"] };
    }
    if (result.status !== "observed" || result.quotaSource !== "provider_api" || "reason" in result) {
      throw new Error("Invalid quota probe source");
    }
    const rawQuotaObservedAt = text(result.quotaObservedAt, 40);
    const parsedObserved = Date.parse(rawQuotaObservedAt);
    const observed = clampRoutingQuotaObservedTime(parsedObserved, now);
    if (observed === undefined) throw new Error("Invalid quota probe observation time");
    const quotaObservedAt = observed < parsedObserved ? new Date(observed).toISOString() : rawQuotaObservedAt;
    const quotaAccount = result.quotaAccount === undefined ? undefined
      : quotaProbeAccount(result.quotaAccount, request.accountBalance === true);
    const quotaUsages = result.quotaUsages === undefined ? []
      : probeWindows(result.quotaUsages, request.windowLabels === true, false);
    const scopedQuotaUsages = result.scopedQuotaUsages === undefined ? undefined
      : probeWindows(result.scopedQuotaUsages, true, true);
    // A reading without account windows is scoped windows alone, or a prepaid
    // balance; each only when asked for.
    if (result.quotaUsages !== undefined ? !quotaUsages.length
      : !scopedQuotaUsages?.length && !quotaAccountBalance(quotaAccount)) {
      throw new Error("Invalid quota probe window count");
    }
    // Preserve original observation time, including cached/expired readings.
    // Routing freshness policy, not transport receipt time, decides eligibility.
    return { ...identity, status: "observed", quotaSource: "provider_api", quotaObservedAt, quotaUsages,
      ...(scopedQuotaUsages ? { scopedQuotaUsages } : {}), ...(quotaAccount ? { quotaAccount } : {}) };
  });
  return { requestId: request.requestId, connectionEpoch: request.connectionEpoch, results };
}

function quotaProbeAccount(value: unknown, money: boolean): LlmQuotaAccount | undefined {
  const row = record(value, ["allowed", "credits"]);
  if (row.allowed !== undefined && typeof row.allowed !== "boolean") throw new Error("Invalid quota probe account");
  if (row.credits !== undefined) {
    const credits = record(row.credits, money ? ["balance", "unlimited", "currency"] : ["balance", "unlimited"]);
    if ((credits.currency !== undefined && (typeof credits.currency !== "string" || !/^[A-Z]{3}$/u.test(credits.currency))) ||
        (credits.balance !== undefined && (typeof credits.balance !== "number" || !Number.isFinite(credits.balance) ||
        credits.balance < 0)) || (credits.unlimited !== undefined && typeof credits.unlimited !== "boolean")) {
      throw new Error("Invalid quota probe credits");
    }
  }
  return parseLlmQuotaAccount(row);
}
