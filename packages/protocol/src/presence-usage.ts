import type { LlmUsage } from "./authority-runtime.js";

export function usageWithoutQuota(usage?: LlmUsage): LlmUsage | undefined {
  if (!usage) return undefined;
  const {
    quotaSource: _quotaSource,
    quotaState: _quotaState,
    quotaUsages: _quotaUsages,
    quotaObservedAt: _quotaObservedAt,
    quotaAccount: _quotaAccount,
    ...localUsage
  } = usage;
  return Object.keys(localUsage).length > 0 ? localUsage : undefined;
}

export function mergeUsageAttributes(...candidates: Array<LlmUsage | undefined>): LlmUsage | undefined {
  const merged: Record<string, unknown> = {};
  for (const usage of candidates) {
    if (!usage) continue;
    for (const [key, value] of Object.entries(usage)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? (merged as LlmUsage) : undefined;
}

export function accountQuotaUsageFromCandidates(...candidates: Array<LlmUsage | undefined>): LlmUsage | undefined {
  let latest: LlmUsage | undefined;
  for (const usage of candidates) {
    if (usage?.quotaState !== "unknown" && (usage?.quotaSource !== "provider_api" || !usage.quotaUsages?.length)) continue;
    const time = Date.parse(usage.quotaObservedAt ?? "");
    if (usage.quotaState !== "unknown" && !Number.isFinite(time)) continue;
    const previous = Date.parse(latest?.quotaObservedAt ?? "");
    if (!latest || time > previous || (!Number.isFinite(previous) && Number.isFinite(time)) ||
        (time === previous && usage.quotaState === "unknown")) latest = usage;
  }
  if (!latest) return undefined;
  return { quotaState: latest.quotaState ?? "observed", quotaObservedAt: latest.quotaObservedAt,
    ...(latest.quotaState !== "unknown" ? { quotaSource: "provider_api", quotaUsages: latest.quotaUsages,
      ...(latest.quotaAccount ? { quotaAccount: latest.quotaAccount } : {}) } : {}) };
}

export function mergeAccountLevelLlmUsage(current?: LlmUsage, update?: LlmUsage): LlmUsage | undefined {
  if (!update) return current;
  const quota = accountQuotaUsageFromCandidates(update, current);
  return mergeUsageAttributes(usageWithoutQuota(update), usageWithoutQuota(current), quota);
}

export function mergeLlmUsagePreferringQuotas(
  current?: LlmUsage,
  update?: LlmUsage
): LlmUsage | undefined {
  if (!update) return current;
  if (!current) return update;
  if (update.quotaState || current.quotaState) {
    return mergeAccountLevelLlmUsage(current, update);
  }
  if (update.quotaSource === "provider_api" && Boolean(update.quotaUsages?.length)) {
    const previousTime = Date.parse(current.quotaObservedAt ?? "");
    const incomingTime = Date.parse(update.quotaObservedAt ?? "");
    // Concurrent frames can arrive out of order. Token counters may advance
    // without replacing a newer provider sample.
    if (Number.isFinite(previousTime) && Number.isFinite(incomingTime) && incomingTime < previousTime) {
      const {
        quotaSource: _quotaSource,
        quotaUsages: _quotaUsages,
        quotaObservedAt: _quotaObservedAt,
        quotaAccount: _quotaAccount,
        ...localUsage
      } = update;
      return { ...current, ...localUsage };
    }
    return update;
  }
  if (current.quotaSource === "provider_api" && Boolean(current.quotaUsages?.length)) {
    return {
      ...current,
      ...update,
      quotaSource: "provider_api",
      quotaUsages: current.quotaUsages,
      quotaAccount: current.quotaAccount,
      ...(current.quotaObservedAt ? { quotaObservedAt: current.quotaObservedAt } : {}),
    };
  }
  return update;
}
