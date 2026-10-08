import { utf8ByteLength } from "./hex.js";
import { routingQuotaObservation, routingQuotaResetTime, type RoutingObservation } from "./agent-routing.js";
import { parseLlmQuotaAccount, type LlmQuotaAccount } from "./authority-runtime.js";

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
}

export interface RoutingQuotaProbeWindow {
  percent: number;
  resetAt?: string;
  /** The provider's name for the window, only when the probe asked for it. */
  label?: string;
}

/** One provider window as it is shown: share used and when it resets. */
export interface RoutingQuotaWindow {
  label?: string;
  usedPercent: number;
  /** ISO-8601 instant the window resets. */
  resetAt?: string;
}

export const ROUTING_QUOTA_MAX_WINDOWS = 8;

export type RoutingQuotaProbeResult = RoutingQuotaProbeTarget & (
  | { status: "observed"; quotaSource: "provider_api"; quotaObservedAt: string;
      quotaUsages: RoutingQuotaProbeWindow[]; quotaAccount?: LlmQuotaAccount }
  | { status: "unavailable"; reason: "unsupported" | "configuration_unavailable" | "provider_unavailable" | "timeout" }
);

export interface RoutingQuotaProbeResponse {
  requestId: string;
  connectionEpoch: number;
  results: RoutingQuotaProbeResult[];
}

export const ROUTING_QUOTA_PROBE_MAX_TARGETS = 32;

/** Only server-bound targets can become quota facts. Unavailable/expired reads
 * yield no write: they cannot erase a prior exhausted observation or become 0%
 * used. The caller owns authenticated target/pool resolution and persistence. */
export function routingQuotaProbeObservations(value: unknown, expected: RoutingQuotaProbeRequest,
  now: number): Array<RoutingQuotaProbeTarget & { observation: RoutingObservation<number>; windows: RoutingQuotaWindow[];
    account?: LlmQuotaAccount }> {
  const response = parseRoutingQuotaProbeResponse(value, expected, now);
  return response.results.flatMap(result => {
    if (result.status !== "observed") return [];
    const observation = routingQuotaObservation(result, now);
    return observation ? [{ targetId: result.targetId,
      configurationDigest: result.configurationDigest, observation,
      windows: routingQuotaWindows(result.quotaUsages, now),
      ...(result.quotaAccount ? { account: result.quotaAccount } : {}) }] : [];
  });
}

/** The windows of one reading that have not reset yet, for display only;
 * routing reads the single observation above. */
export function routingQuotaWindows(windows: readonly RoutingQuotaProbeWindow[], now: number): RoutingQuotaWindow[] {
  return currentRoutingQuotaWindows(windows.map(({ percent, ...window }) => ({ ...window, usedPercent: percent })), now);
}

/** The windows of a reading, however it arrived (a probe, a stored row, a
 * catalog response), that still count at `now`: a window whose reset time has
 * passed is gone, and one without a readable reset time is kept without one. */
export function currentRoutingQuotaWindows(value: unknown, now: number): RoutingQuotaWindow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RoutingQuotaWindow[] => {
    if (!item || typeof item !== "object") return [];
    const { label, usedPercent, resetAt } = item as Record<string, unknown>;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return [];
    const reset = routingQuotaResetTime(resetAt);
    if (Number.isFinite(reset) && reset <= now) return [];
    return [{ ...(typeof label === "string" && label ? { label } : {}), usedPercent,
      ...(Number.isFinite(reset) ? { resetAt: new Date(reset).toISOString() } : {}) }];
  }).slice(0, ROUTING_QUOTA_MAX_WINDOWS);
}

const QUOTA_WINDOW_UNIT_MS: Record<string, number> = {
  m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, mo: 30 * 86_400_000 };

/** A window's length from its label (`5h`, `1w`, `1mo`), NaN when the label names none. */
function routingQuotaWindowLength(label: string | undefined): number {
  const match = /^(\d+)(mo|m|h|d|w)$/u.exec((label ?? "").trim().toLowerCase());
  return match ? Number(match[1]) * QUOTA_WINDOW_UNIT_MS[match[2]!]! : NaN;
}

/**
 * How fast an account may spend against its provider's pace: each window's
 * remaining share divided by the share of that window still to run before it
 * resets. At 1 the window is spent exactly by its reset; above 1 what is left
 * is lost at the reset unless it is used, so it is the cheaper quota to spend;
 * below 1 it runs out first. Every window caps spending, so the tightest one
 * counts (Cursor, which spends Auto or API by model: the better of the two).
 * A window with no known length or reset counts its remaining share alone; a
 * window without a length of its own (Cursor's Auto and API) takes that of a
 * named window resetting at the same time.
 *
 * `remainingPercent` is the provider's verdict on the whole account: none left
 * is no pace, and an account served past its windows (credits) keeps that
 * small share instead of the windows' zero.
 */
export function routingQuotaPace(quota: { remainingPercent: number; windows?: readonly RoutingQuotaWindow[] },
  now: number): number {
  if (!(quota.remainingPercent > 0)) return 0;
  const windows = currentRoutingQuotaWindows(quota.windows ?? [], now);
  const lengths = new Map(windows.flatMap(window => {
    const length = routingQuotaWindowLength(window.label);
    return Number.isFinite(length) && window.resetAt ? [[window.resetAt, length] as const] : [];
  }));
  const pace = (window: RoutingQuotaWindow) => {
    const remaining = (100 - window.usedPercent) / 100;
    const reset = window.resetAt ? Date.parse(window.resetAt) : NaN;
    const named = routingQuotaWindowLength(window.label);
    const length = Number.isFinite(named) ? named : window.resetAt ? lengths.get(window.resetAt) ?? NaN : NaN;
    if (!Number.isFinite(reset) || !Number.isFinite(length)) return remaining;
    return remaining / Math.min(1, (reset - now) / length);
  };
  const label = (window: RoutingQuotaWindow) => (window.label ?? "").trim().toLowerCase();
  const pools = windows.filter(window => label(window) === "auto" || label(window) === "api");
  const cursorPools = new Set(pools.map(label)).size === 2;
  const paces = (cursorPools ? pools : windows).map(pace);
  const windowsPace = !paces.length ? undefined
    : cursorPools ? Math.max(...paces) : Math.min(...paces);
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
  const row = record(value, ["requestId", "connectionEpoch", "targets", "windowLabels", "quotaAccount"]);
  if (row.windowLabels !== undefined && row.windowLabels !== true) throw new Error("Invalid quota probe window labels");
  if (row.quotaAccount !== undefined && row.quotaAccount !== true) throw new Error("Invalid quota probe account request");
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
    ...(row.quotaAccount === true ? { quotaAccount: true as const } : {}) };
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
      "quotaSource", "quotaObservedAt", "quotaUsages", ...(request.quotaAccount ? ["quotaAccount"] : [])]);
    const identity = target(result);
    if (unseen.get(identity.targetId) !== identity.configurationDigest) throw new Error("Quota probe target mismatch");
    unseen.delete(identity.targetId);
    if (result.status === "unavailable") {
      if (!["unsupported", "configuration_unavailable", "provider_unavailable", "timeout"].includes(String(result.reason)) ||
          "quotaSource" in result || "quotaObservedAt" in result || "quotaUsages" in result || "quotaAccount" in result) {
        throw new Error("Invalid unavailable quota probe result");
      }
      return { ...identity, status: "unavailable", reason: result.reason as Extract<RoutingQuotaProbeResult,
        { status: "unavailable" }>["reason"] };
    }
    if (result.status !== "observed" || result.quotaSource !== "provider_api" || "reason" in result) {
      throw new Error("Invalid quota probe source");
    }
    const quotaObservedAt = text(result.quotaObservedAt, 40);
    const observed = Date.parse(quotaObservedAt);
    if (!Number.isFinite(observed) || observed > now) throw new Error("Invalid quota probe observation time");
    if (!Array.isArray(result.quotaUsages) || !result.quotaUsages.length || result.quotaUsages.length > ROUTING_QUOTA_MAX_WINDOWS) {
      throw new Error("Invalid quota probe window count");
    }
    const quotaUsages = result.quotaUsages.map((value): RoutingQuotaProbeWindow => {
      const window = record(value, request.windowLabels ? ["percent", "resetAt", "label"] : ["percent", "resetAt"]);
      if (typeof window.percent !== "number" || !Number.isFinite(window.percent) ||
          window.percent < 0 || window.percent > 100) throw new Error("Invalid quota probe percentage");
      return { percent: window.percent,
        ...(window.resetAt === undefined ? {} : { resetAt: text(window.resetAt, 40) }),
        ...(window.label === undefined ? {} : { label: text(window.label, 24) }) };
    });
    // Preserve original observation time, including cached/expired readings.
    // Routing freshness policy, not transport receipt time, decides eligibility.
    const quotaAccount = result.quotaAccount === undefined ? undefined : quotaProbeAccount(result.quotaAccount);
    return { ...identity, status: "observed", quotaSource: "provider_api", quotaObservedAt, quotaUsages,
      ...(quotaAccount ? { quotaAccount } : {}) };
  });
  return { requestId: request.requestId, connectionEpoch: request.connectionEpoch, results };
}

function quotaProbeAccount(value: unknown): LlmQuotaAccount | undefined {
  const row = record(value, ["allowed", "credits"]);
  if (row.allowed !== undefined && typeof row.allowed !== "boolean") throw new Error("Invalid quota probe account");
  if (row.credits !== undefined) {
    const credits = record(row.credits, ["balance", "unlimited"]);
    if ((credits.balance !== undefined && (typeof credits.balance !== "number" || !Number.isFinite(credits.balance) ||
        credits.balance < 0)) || (credits.unlimited !== undefined && typeof credits.unlimited !== "boolean")) {
      throw new Error("Invalid quota probe credits");
    }
  }
  return parseLlmQuotaAccount(row);
}
