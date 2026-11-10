import { plainRecord } from "./plain-record.js";
import { cleanAgentModelCatalog as cleanModelCatalog, cleanAgentCommands as cleanCommands,
  cleanAgentCapabilities, cleanAgentPresentationText as cleanText,
  cleanAgentPresentationTextList as cleanTextList } from "./agent-instance-catalogs.js";
import { parseLlmQuotaAccount, parseQuotaObservedAt, localLlmUsage,
  type LlmQuotaUsage, type LlmUsage } from "./authority-runtime.js";
import { parseHarnessParameters, harnessParameterEnabled, harnessParameterKind, harnessParameterValueLabel,
  type HarnessParameter } from "./harness-parameters.js";
import { isAgentRuntimeWaitingKind, isAgentRuntimeIssueKind, isAgentRuntimeNoticeSeverity,
  type AgentInstancePresentation, type AgentGoalStatus, type AgentRuntimeState, type AgentRuntimeWaiting,
  type AgentStatusChip, type SerializedAgent, type WorkspaceRef } from "./authority-foundation.js";
import { isUnlistedParameterTag, parameterTagRule, PARAMETER_TAG_PREFIX } from "./status-tag-registry.js";
import type { AgentInstanceConnectMessage, AgentInstancePresenceUpdateMessage } from "./connections/agent-instance.js";

export type { AgentInstancePresentation } from "./authority-foundation.js";

/** Runtime work is live-only; every other presentation key has a durable slot.
 * Required properties distinguish a complete projection from a message header.
 * Undefined means the runtime has not reported the field; [] withdraws a catalog. */
export type AgentInstanceDurableKey = Exclude<keyof AgentInstancePresentation, "activity" | "files" | "intent" | "runtimeState">;
export type AgentInstanceDurablePresentation = {
  [Key in AgentInstanceDurableKey]: AgentInstancePresentation[Key];
};
export type AgentMessagePresentation = Pick<AgentInstancePresentation, "goal" | "gitBranch" | "model" | "effort" | "statusChips">;

// Exhaustive at compile time. PostgreSQL derives its projection from these keys.
const DURABLE_FIELDS = {
  clientVersion: true, hostName: true, workspace: true, workspaceName: true,
  runWorktreeBaseRef: true, gitBranch: true, capabilities: true, goal: true,
  model: true, models: true, modelsObservedAt: true, effort: true, commands: true,
  parameters: true, parametersObservedAt: true, statusChips: true, usage: true,
} satisfies Record<AgentInstanceDurableKey, true>;
export const AGENT_INSTANCE_DURABLE_KEYS = Object.keys(DURABLE_FIELDS) as AgentInstanceDurableKey[];
const PRESENTATION_KEYS: readonly string[] = [...AGENT_INSTANCE_DURABLE_KEYS, "activity", "files", "intent", "runtimeState"];

export function initialAgentInstancePresentation(input: {
  message: AgentInstanceConnectMessage;
  runMetadata: Record<string, unknown>;
  workspace?: unknown;
}): AgentInstancePresentation | undefined {
  const metadata = {
    ...input.runMetadata,
    ...input.message.runContext,
  };
  return sanitizeAgentInstancePresentation({
    clientVersion: input.message.runtime.clientVersion ?? metadata.clientVersion,
    hostName: metadata.hostName ?? metadata.hostname,
    workspace: input.workspace ?? (
      typeof metadata.workspaceMachineId === "string" &&
      typeof metadata.workspaceCwd === "string"
        ? { machineId: metadata.workspaceMachineId, canonicalCwd: metadata.workspaceCwd }
        : undefined
    ),
    workspaceName: metadata.workspaceName,
    runWorktreeBaseRef: metadata.runWorktreeBaseRef,
    gitBranch: metadata.gitBranch,
    capabilities: input.message.runtime.capabilities,
  });
}

export function mergeAgentInstancePresentation(
  current: Readonly<AgentInstancePresentation> | undefined,
  update: Readonly<AgentInstancePresenceUpdateMessage>,
): AgentInstancePresentation | undefined {
  // Sessions can survive a Hub deploy. Canonicalize the retained snapshot here
  // so quota data from an older runtime cannot remain visible until that
  // runtime happens to send another presence frame.
  const next: AgentInstancePresentation = {
    ...sanitizeAgentInstancePresentation(current),
  };
  const set = <Key extends keyof AgentInstancePresentation>(
    key: Key,
    value: AgentInstancePresentation[Key] | undefined,
  ) => {
    if (value === undefined) delete next[key];
    else next[key] = value;
  };

  if (hasOwn(update, "activity")) set("activity", cleanText(update.activity, 512));
  if (hasOwn(update, "files")) set("files", cleanTextList(update.files, 64, 512));
  if (hasOwn(update, "intent")) set("intent", cleanText(update.intent, 512));
  if (hasOwn(update, "gitBranch")) set("gitBranch", cleanText(update.gitBranch, 256));
  if (hasOwn(update, "runtimeState")) {
    set("runtimeState", cleanRuntimeState(update.runtimeState));
  } else if (update.status && update.status !== "busy") {
    delete next.runtimeState;
  }
  if (hasOwn(update, "capabilities")) {
    set("capabilities", cleanAgentCapabilities(update.capabilities));
  }
  if (hasOwn(update, "goal")) {
    set("goal", update.goal === null ? undefined : cleanGoal(update.goal));
  }
  if (hasOwn(update, "model")) {
    const model = cleanModelId(update.model);
    if (model !== next.model && !hasOwn(update, "parameters") && next.parameters !== undefined) {
      set("parameters", []);
      set("parametersObservedAt", new Date().toISOString());
    }
    set("model", model);
  }
  if (hasOwn(update, "models")) {
    const models = cleanModelCatalog(update.models);
    set("models", models);
    // Stamp only an actual catalog report, never an unrelated heartbeat/read.
    set("modelsObservedAt", models?.length ? new Date().toISOString() : undefined);
  }
  if (hasOwn(update, "effort")) set("effort", cleanText(update.effort, 64));
  if (hasOwn(update, "parameters")) {
    const parameters = cleanParameters(update.parameters) ?? [];
    set("parameters", parameters);
    set("parametersObservedAt", new Date().toISOString());
  }
  if (hasOwn(update, "commands")) set("commands", cleanCommands(update.commands));
  if (hasOwn(update, "statusChips")) {
    set(
      "statusChips",
      statusChipsFromModelEffort(
        next.model,
        next.effort,
        cleanStatusChips(update.statusChips),
      ),
    );
  } else if (hasOwn(update, "model") || hasOwn(update, "effort")) {
    set("statusChips", statusChipsFromModelEffort(next.model, next.effort, next.statusChips));
  }
  if (["parameters", "statusChips", "model", "effort"].some(key => hasOwn(update, key))) {
    set("statusChips", withParameterChips(next.parameters, next.statusChips, current?.statusChips));
  }
  if (hasOwn(update, "usage")) {
    const rawUsage = (update as { usage?: LlmUsage | null }).usage;
    const incomingUsage = rawUsage === null ? undefined : cleanUsage(rawUsage);
    set("usage", rawUsage === null
      ? undefined
      : mergeUsagePreferringQuotas(next.usage, incomingUsage));
    // Runtimes publish usage more often than presentation chips. A retained
    // quota/context chip would otherwise win over the newer usage meter in the
    // client, leaving a stale value such as 100% beside a current 2% quota.
    // Only remove chips which are mirrors of the refreshed usage facts; model,
    // effort, and runtime-specific labels remain intact.
    if (!hasOwn(update, "statusChips")) {
      set("statusChips", withoutStaleUsageMeterChips(next.statusChips, incomingUsage, rawUsage === null));
    }
  }
  // Quota meter chips are session-provided presentation hints. Account quota
  // must instead render from a provider_api usage snapshot below.
  set("statusChips", withoutQuotaMeterChips(next.statusChips));

  return Object.keys(next).length > 0 ? next : undefined;
}

/** The one normalizer used by the runtime writer and durable record reader.
 * The required result is checked against every runtime presentation field. */
export function normalizeAgentInstanceDurablePresentation(input: unknown): AgentInstanceDurablePresentation {
  const value = plainRecord(input) ?? {};
  const model = cleanModelId(value.model);
  const effort = cleanText(value.effort, 64);
  return {
    clientVersion: cleanText(value.clientVersion, 64),
    hostName: cleanText(value.hostName, 256),
    workspace: cleanWorkspaceRef(value.workspace),
    workspaceName: cleanText(value.workspaceName, 256),
    runWorktreeBaseRef: cleanText(value.runWorktreeBaseRef, 256),
    gitBranch: cleanText(value.gitBranch, 256),
    capabilities: cleanAgentCapabilities(value.capabilities),
    goal: cleanGoal(value.goal),
    model,
    models: cleanModelCatalog(value.models),
    modelsObservedAt: observedAt(value.modelsObservedAt),
    effort,
    commands: cleanCommands(value.commands),
    parameters: cleanParameters(value.parameters),
    parametersObservedAt: observedAt(value.parametersObservedAt),
    statusChips: withoutQuotaMeterChips(statusChipsFromModelEffort(model, effort, cleanStatusChips(value.statusChips))),
    usage: cleanUsage(value.usage),
  };
}

function observedAt(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

/** Compact only after normalization; omission remains a wire compatibility fact. */
export function definedAgentInstanceDurablePresentation(input: unknown): Partial<AgentInstanceDurablePresentation> {
  return Object.fromEntries(Object.entries(normalizeAgentInstanceDurablePresentation(input))
    .filter(([, value]) => value !== undefined));
}

export function sanitizeAgentInstancePresentation(value: unknown): AgentInstancePresentation | undefined {
  if (!record(value) || Object.keys(value).some(key => !PRESENTATION_KEYS.includes(key))) return undefined;
  const result = Object.fromEntries(Object.entries({
    ...normalizeAgentInstanceDurablePresentation(value),
    activity: cleanText(value.activity, 512),
    files: cleanTextList(value.files, 64, 512),
    intent: cleanText(value.intent, 512),
    runtimeState: cleanRuntimeState(value.runtimeState),
  }).filter(([, field]) => field !== undefined));
  return Object.keys(result).length ? result : undefined;
}

export function agentMessagePresentation(
  presentation: Readonly<AgentInstancePresentation> | undefined,
): AgentMessagePresentation | undefined {
  const canonical = sanitizeAgentInstancePresentation(presentation);
  if (!canonical) return undefined;
  const snapshot = {
    ...(canonical.goal ? { goal: canonical.goal } : {}),
    ...(canonical.gitBranch ? { gitBranch: canonical.gitBranch } : {}),
    ...(canonical.model ? { model: canonical.model } : {}),
    ...(canonical.effort ? { effort: canonical.effort } : {}),
    ...(canonical.statusChips?.length ? { statusChips: canonical.statusChips } : {}),
  };
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

export function agentSummaryPresentation(
  presentation: Readonly<AgentInstancePresentation> | undefined,
): Partial<Pick<
  SerializedAgent,
  "activity" | "files" | "intent" | "runtimeState" | "model" | "usage"
>> {
  return {
    ...(presentation?.activity ? { activity: presentation.activity } : {}),
    ...(presentation?.files ? { files: presentation.files } : {}),
    ...(presentation?.intent ? { intent: presentation.intent } : {}),
    ...(presentation?.runtimeState ? { runtimeState: presentation.runtimeState } : {}),
    ...(presentation?.model ? { model: presentation.model } : {}),
    ...(presentation?.usage ? { usage: presentation.usage } : {}),
  };
}

export function compactAgentInstancePresentationForHibernation(
  presentation: Readonly<AgentInstancePresentation> | undefined,
): AgentInstancePresentation | undefined {
  if (!presentation) return undefined;
  return sanitizeAgentInstancePresentation({
    // Large catalogs follow the existing model-catalog omission on compact
    // hibernation. Durable observations remain available to launch routing.
    ...(presentation.parameters?.length === 0 ? { parameters: [], parametersObservedAt: presentation.parametersObservedAt } : {}),
    commands: presentation.commands,
    capabilities: presentation.capabilities,
    clientVersion: presentation.clientVersion,
    hostName: presentation.hostName,
    workspace: presentation.workspace,
    workspaceName: presentation.workspaceName,
    runWorktreeBaseRef: presentation.runWorktreeBaseRef,
    activity: presentation.activity,
    intent: presentation.intent,
    gitBranch: presentation.gitBranch,
    runtimeState: presentation.runtimeState,
    goal: presentation.goal,
    model: presentation.model,
    effort: presentation.effort,
    statusChips: presentation.statusChips?.slice(0, 8),
    usage: presentation.usage
      ? {
          ...presentation.usage,
          quotaUsages: presentation.usage.quotaUsages?.slice(0, 8),
        }
      : undefined,
  });
}

/**
 * Runtimes report every native parameter; the status-tag registry decides
 * which of them become tags, under its own name. A listed switch reads as that
 * name while on and shows nothing while off; a listed choice reads as its
 * value's display name, its default included; a provider notice qualifies
 * either. A switch that is another spelling of a parameter (Fast for a service
 * tier) stands in for it while on. A runtime that omits its catalog keeps the
 * tags derived from the last one it reported.
 */
function withParameterChips(
  parameters: readonly HarnessParameter[] | undefined,
  chips: AgentStatusChip[] | undefined,
  previous: readonly AgentStatusChip[] | undefined,
): AgentStatusChip[] | undefined {
  const base = (chips ?? []).filter(chip => !chip.id.startsWith(PARAMETER_TAG_PREFIX));
  const taken = new Set(base.map(chip => chip.id.toLowerCase()));
  const shown = (parameter: HarnessParameter) => parameter.currentValue !== undefined &&
    (harnessParameterKind(parameter) === "enum" || harnessParameterEnabled(parameter.currentValue));
  // Only a listed alias that is itself shown may stand in for its target.
  const covered = new Set((parameters ?? []).filter(parameter => parameter.aliasOf &&
    parameterTagRule(parameter.id) && shown(parameter)).map(parameter => parameter.aliasOf!));
  const keys = new Set<string>();
  const derived = parameters === undefined
    ? (previous ?? []).filter(chip => chip.id.startsWith(PARAMETER_TAG_PREFIX) && !isUnlistedParameterTag(chip.id))
    : parameters.flatMap((parameter): AgentStatusChip[] => {
      const rule = parameterTagRule(parameter.id);
      if (!rule || keys.has(rule.key) || taken.has(rule.key) || covered.has(parameter.id) || !shown(parameter)) return [];
      keys.add(rule.key);
      const kind = harnessParameterKind(parameter);
      const value = kind === "boolean" ? rule.label : harnessParameterValueLabel(parameter, parameter.currentValue!);
      return [{ id: `${PARAMETER_TAG_PREFIX}${rule.key}`, label: rule.label,
        value: (parameter.notice ? `${value} · ${parameter.notice}` : value).slice(0, 128), parameterKind: kind }];
    });
  const result = [...base, ...derived].slice(0, 16);
  return result.length > 0 ? result : undefined;
}

function statusChipsFromModelEffort(
  model?: string,
  effort?: string,
  existing?: AgentStatusChip[],
): AgentStatusChip[] | undefined {
  const existingModel = existing?.find((chip) => chip.id.toLowerCase() === "model");
  const existingEffort = existing?.find((chip) => chip.id.toLowerCase() === "effort");
  const builtIns: AgentStatusChip[] = [];
  if (model) {
    builtIns.push({
      ...existingModel,
      id: "model",
      label: existingModel?.label || "Model",
      value: model,
    });
  }
  if (effort) {
    builtIns.push({
      ...existingEffort,
      id: "effort",
      label: existingEffort?.label || "Effort",
      value: effort,
    });
  }
  const dynamicLimit = Math.max(0, 16 - builtIns.length);
  const dynamic = (existing || [])
    .filter((chip) => !["model", "effort"].includes(chip.id.toLowerCase()))
    .slice(0, dynamicLimit);
  const chips = [...dynamic, ...builtIns];
  return chips.length > 0 ? chips : undefined;
}

function mergeUsagePreferringQuotas(
  current: LlmUsage | undefined,
  incoming: LlmUsage | undefined,
): LlmUsage | undefined {
  current = withoutUntrustedQuotaUsage(current);
  incoming = withoutUntrustedQuotaUsage(incoming);
  if (!incoming || Object.keys(incoming).length === 0) return current;
  if (!current) return incoming;
  if (incoming.quotaUsages?.length) {
    const previousTime = Date.parse(current.quotaObservedAt ?? "");
    const incomingTime = Date.parse(incoming.quotaObservedAt ?? "");
    // Concurrent turn/periodic frames can reach the wire out of order. Local
    // token counters may advance without replacing a newer provider sample.
    if (Number.isFinite(previousTime) && Number.isFinite(incomingTime) && incomingTime < previousTime) {
      return { ...current, ...localLlmUsage(incoming) };
    }
    return { ...current, ...incoming, quotaObservedAt: incoming.quotaObservedAt };
  }
  if (current.quotaUsages?.length) {
    return { ...current, ...incoming, quotaUsages: current.quotaUsages };
  }
  return { ...current, ...incoming };
}

function withoutUntrustedQuotaUsage(usage: LlmUsage | undefined): LlmUsage | undefined {
  if (!usage) return undefined;
  if (usage.quotaSource === "provider_api" && usage.quotaUsages?.length) return usage;
  return localLlmUsage(usage);
}

function withoutStaleUsageMeterChips(
  chips: AgentStatusChip[] | undefined,
  usage: LlmUsage | undefined,
  clearAll: boolean,
): AgentStatusChip[] | undefined {
  const refreshQuotaMeters = clearAll || Boolean(usage?.quotaUsages?.length);
  const refreshContextMeter = clearAll || usage?.contextUsagePercent !== undefined || (
    usage?.contextUsedTokens !== undefined && usage.contextWindowTokens !== undefined
  );
  if (!chips?.length || (!refreshQuotaMeters && !refreshContextMeter)) return chips;

  const current = chips.filter((chip) => {
    const id = chip.id.toLowerCase();
    return !(refreshQuotaMeters && id.startsWith("quota:")) && !(refreshContextMeter && id === "ctx");
  });
  return current.length ? current : undefined;
}

export function agentRuntimePresentation(value: unknown): AgentRuntimeState | undefined {
  return cleanRuntimeState(value);
}

function cleanRuntimeState(value: unknown): AgentRuntimeState | undefined {
  if (!record(value) || (value.status !== "idle" && value.status !== "running")) return undefined;
  return {
    status: value.status,
    ...(cleanText(value.source, 128) ? { source: cleanText(value.source, 128) } : {}),
    ...(cleanText(value.activeChannelId, 128)
      ? { activeChannelId: cleanText(value.activeChannelId, 128) }
      : {}),
    ...(cleanText(value.activeMessageId, 128)
      ? { activeMessageId: cleanText(value.activeMessageId, 128) }
      : {}),
    ...(cleanText(value.activeThreadId, 128)
      ? { activeThreadId: cleanText(value.activeThreadId, 128) }
      : {}),
    ...(cleanText(value.activeTurnId, 128)
      ? { activeTurnId: cleanText(value.activeTurnId, 128) }
      : {}),
    ...(cleanNonnegativeInteger(value.startedAtMillis) !== undefined
      ? { startedAtMillis: cleanNonnegativeInteger(value.startedAtMillis) }
      : {}),
    ...(cleanNonnegativeInteger(value.updatedAtMillis) !== undefined
      ? { updatedAtMillis: cleanNonnegativeInteger(value.updatedAtMillis) }
      : {}),
    ...(cleanRuntimeWaiting(value.waiting) ? { waiting: cleanRuntimeWaiting(value.waiting) } : {}),
    ...(cleanRuntimeIssue(value.issue) ? { issue: cleanRuntimeIssue(value.issue) } : {}),
    ...(cleanRuntimeNotice(value.notice) ? { notice: cleanRuntimeNotice(value.notice) } : {}),
  };
}

function cleanRuntimeIssue(value: unknown): AgentRuntimeState["issue"] {
  if (!record(value) || !isAgentRuntimeIssueKind(value.kind)) return undefined;
  const sinceMillis = cleanRuntimeSinceMillis(value.sinceMillis);
  return sinceMillis === undefined ? undefined : { kind: value.kind, sinceMillis };
}

function cleanRuntimeNotice(value: unknown): AgentRuntimeState["notice"] {
  if (!record(value) || !isAgentRuntimeNoticeSeverity(value.severity)) return undefined;
  const sinceMillis = cleanRuntimeSinceMillis(value.sinceMillis);
  return sinceMillis === undefined ? undefined : { severity: value.severity, sinceMillis };
}

function cleanRuntimeSinceMillis(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function cleanRuntimeWaiting(value: unknown): AgentRuntimeWaiting | undefined {
  if (!record(value) || !isAgentRuntimeWaitingKind(value.kind)) return undefined;
  const sinceMillis = cleanNonnegativeInteger(value.sinceMillis);
  if (sinceMillis === undefined) return undefined;
  const label = cleanText(value.label, 160);
  const details = cleanTextList(value.details, 4, 300);
  const count = cleanNonnegativeInteger(value.count);
  return { kind: value.kind, ...(label ? { label } : {}), ...(count !== undefined && count <= 100_000 ? { count } : {}),
    ...(details ? { details } : {}), sinceMillis };
}

function cleanGoal(value: unknown): AgentGoalStatus | undefined {
  if (!record(value)) return undefined;
  const goal: AgentGoalStatus = {
    ...(typeof value.active === "boolean" ? { active: value.active } : {}),
    ...(cleanText(value.objective, 1_024) ? { objective: cleanText(value.objective, 1_024) } : {}),
    ...(cleanText(value.status, 128) ? { status: cleanText(value.status, 128) } : {}),
    ...(cleanText(value.updatedAt, 64) ? { updatedAt: cleanText(value.updatedAt, 64) } : {}),
    ...(cleanText(value.reason, 512) ? { reason: cleanText(value.reason, 512) } : {}),
    ...(cleanText(value.nextAction, 512) ? { nextAction: cleanText(value.nextAction, 512) } : {}),
  };
  for (const key of [
    "tokensUsed",
    "timeUsedSeconds",
    "iterationCount",
    "contextUsed",
    "toolCallCount",
  ] as const) {
    const number = cleanNonnegativeNumber(value[key]);
    if (number !== undefined) goal[key] = number;
  }
  return Object.keys(goal).length > 0 ? goal : undefined;
}

function cleanStatusChips(value: unknown): AgentStatusChip[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const chips: AgentStatusChip[] = [];
  for (const candidate of value.slice(0, 16)) {
    if (!record(candidate)) continue;
    const id = cleanText(candidate.id, 64);
    const label = cleanText(candidate.label, 64);
    let chipValue = cleanText(candidate.value, 128);
    if (id?.toLowerCase() === "model") {
      chipValue = cleanModelId(chipValue);
    }
    if (isDefaultAgentModeChip(id, chipValue) || (id && isUnlistedParameterTag(id))) {
      continue;
    }
    const percent = cleanPercent(candidate.percent);
    // A tag needs something to show: text, a meter, or both.
    if (!id || !label || (!chipValue && percent === undefined)) continue;
    if (seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    chips.push({
      id,
      label,
      ...(chipValue ? { value: chipValue } : {}),
      ...(cleanText(candidate.source, 64) ? { source: cleanText(candidate.source, 64) } : {}),
      ...(percent === undefined ? {} : { percent }),
      ...(cleanText(candidate.resetAt, 64) ? { resetAt: cleanText(candidate.resetAt, 64) } : {}),
      ...(candidate.parameterKind === "boolean" || candidate.parameterKind === "enum"
        ? { parameterKind: candidate.parameterKind } : {}),
    });
  }
  return chips.length > 0 ? chips : undefined;
}

function cleanUsage(value: unknown): LlmUsage | undefined {
  if (!record(value)) return undefined;
  const usage: LlmUsage = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "contextUsedTokens",
    "contextWindowTokens",
    "cachedInputTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "reasoningTokens",
    "toolCallCount",
  ] as const) {
    const number = cleanNonnegativeNumber(value[key]);
    if (number !== undefined) usage[key] = number;
  }
  const contextUsagePercent = cleanNonnegativeNumber(value.contextUsagePercent);
  if (contextUsagePercent !== undefined) usage.contextUsagePercent = contextUsagePercent;
  const costUsd = cleanNonnegativeNumber(value.costUsd);
  if (costUsd !== undefined) usage.costUsd = costUsd;
  // A rate-limit shape alone is insufficient: older app-server sessions emit
  // those values per session, often stale or pegged at 100%. The only quota
  // authority accepted over presence is an explicit provider API read.
  if (value.quotaState === "unknown") {
    usage.quotaState = "unknown";
    const at = parseQuotaObservedAt(value.quotaObservedAt);
    if (at) usage.quotaObservedAt = at;
  } else if (value.quotaSource === "provider_api") {
    if (value.quotaState === "observed" || value.quotaState === "exhausted") usage.quotaState = value.quotaState;
    const quotaUsages = cleanQuotaUsages(value.quotaUsages);
    if (quotaUsages) {
      usage.quotaSource = "provider_api";
      usage.quotaUsages = quotaUsages;
      const quotaObservedAt = parseQuotaObservedAt(value.quotaObservedAt);
      if (quotaObservedAt) usage.quotaObservedAt = quotaObservedAt;
      const quotaAccount = parseLlmQuotaAccount(value.quotaAccount);
      if (quotaAccount) usage.quotaAccount = quotaAccount;
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function withoutQuotaMeterChips(
  chips: AgentStatusChip[] | undefined,
): AgentStatusChip[] | undefined {
  const filtered = chips?.filter((chip) => !chip.id.toLowerCase().startsWith("quota:"));
  return filtered?.length ? filtered : undefined;
}

function cleanQuotaUsages(value: unknown): LlmQuotaUsage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const quotas = value.slice(0, 16).flatMap((candidate) => {
    if (!record(candidate)) return [];
    const quota: LlmQuotaUsage = {
      ...(cleanText(candidate.label, 64) ? { label: cleanText(candidate.label, 64) } : {}),
      ...(cleanText(candidate.window, 64) ? { window: cleanText(candidate.window, 64) } : {}),
      ...(cleanText(candidate.resetAt, 64) ? { resetAt: cleanText(candidate.resetAt, 64) } : {}),
    };
    for (const key of ["used", "limit", "remaining", "percent"] as const) {
      const number = cleanNonnegativeNumber(candidate[key]);
      if (number !== undefined) quota[key] = number;
    }
    return Object.keys(quota).length > 0 ? [quota] : [];
  });
  return quotas.length > 0 ? quotas : undefined;
}

/** Drop Cursor variants-mode placeholders such as `default[]`. */
function cleanModelId(value: unknown): string | undefined {
  const clean = cleanText(value, 128);
  if (!clean) return undefined;
  if (/^default\[\s*\]$/iu.test(clean)) return undefined;
  return clean;
}

/** Default Agent mode is ambient; only Plan / Ask / other modes keep a chip. */
function isDefaultAgentModeChip(id: string | undefined, value: string | undefined): boolean {
  if (id?.toLowerCase() !== "mode") return false;
  return Boolean(value && /^agent$/iu.test(value.trim()));
}

/** Meter fill as reported, clamped to the 0-100 the tag contract promises. */
function cleanPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

function cleanWorkspaceRef(value: unknown): WorkspaceRef | undefined {
  if (!record(value)) return undefined;
  const machineId = cleanText(value.machineId, 256);
  const canonicalCwd = cleanText(value.canonicalCwd, 4_096);
  return machineId && canonicalCwd ? { machineId, canonicalCwd } : undefined;
}

function cleanNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function cleanNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return plainRecord(value) !== undefined;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cleanParameters(value: unknown): HarnessParameter[] | undefined {
  try { return parseHarnessParameters(value); } catch { return undefined; }
}
