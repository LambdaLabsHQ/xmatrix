import { parseHarnessParameterValues } from "./harness-parameters.js";
import { configurationFields } from "./configuration-fields.js";
import { parseLaunchParameterEvidence, type LaunchParameterEvidence } from "./launch-parameter-evidence.js";
import { canonicalRegistrationHarness } from "./agent-registration.js";
import { parseLlmQuotaAccount } from "./authority-runtime.js";
import { hasControlCharacter, replaceControlCharacters } from "./field-validation.js";

/** Owner declarations describe an environment; they never grant access. */
export interface AgentRoutingDeclaration {
  schemaVersion: 1;
  enabled: boolean;
  models: string[];
  /** Owner-declared canonical model -> harness/provider model identifier. */
  modelAliases?: Record<string, string>;
  description: string;
  /** Owner-selected, registered local directory for tasks without a repository. */
  defaultWorkspace?: string;
  /** Shared provider-account pool. Unknown stays unknown; it never grants Space access. */
  quotaPoolId?: string;
  availability: "interactive" | "unattended" | "unknown";
  availableUntil?: string;
  capabilities: Array<{ key: string; description: string; expiresAt: string }>;
}

export interface RoutingObservation<T> {
  value: T;
  observedAt: string;
  expiresAt: string;
  source: "daemon" | "provider" | "launch-authority";
}

export interface RoutingModelOption {
  model: string;
  description: string;
  efforts: Array<{ value: string; description: string }>;
}

/** A received catalog is an observation, not permission or a fabricated default. */
export function routingModelCatalogObservation(value: unknown, observedAt: unknown, now: number): RoutingObservation<RoutingModelOption[]> | undefined {
  const at = typeof observedAt === "string" ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(at) || at > now || now - at >= 86_400_000 || !Array.isArray(value) || value.length > 100) return undefined;
  const clean = (value: unknown, limit: number): string => typeof value === "string" && value.length <= limit && !hasControlCharacter(value) ? value.trim() : "";
  const models: RoutingModelOption[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || raw.hidden === true) continue;
    const model = clean(raw.model, 160);
    if (!model || models.some(item => item.model === model)) continue;
    const efforts: RoutingModelOption["efforts"] = [];
    for (const effort of Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts.slice(0, 16) : []) {
      const value = clean(effort?.reasoningEffort, 80);
      if (value && !efforts.some(item => item.value === value)) efforts.push({ value, description: clean(effort.description, 512) });
    }
    models.push({ model, description: clean(raw.description, 512), efforts });
  }
  return models.length ? { value: models, observedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 86_400_000).toISOString(), source: "launch-authority" } : undefined;
}

/** Machine measurements are decision facts, never concurrency limits. */
export interface MachineResourceObservation {
  observedAt: string;
  cpuLogicalCount?: number;
  cpuUsagePercent?: number;
  memoryTotalBytes?: number;
  memoryAvailableBytes?: number;
  swapTotalBytes?: number;
  swapFreeBytes?: number;
  /** 1, 5 and 15 minute run-queue averages; absent where the OS has none (Windows). */
  loadAverage?: [number, number, number];
  /** The filesystem holding the daemon user's home directory. */
  diskTotalBytes?: number;
  diskAvailableBytes?: number;
  /** Host abilities the daemon verified on this machine, e.g. `github` when the
   *  daemon user's GitHub CLI is logged in. Evidence, never a credential. */
  hostCapabilities?: string[];
  /** The host runs on a built-in battery: its owner may close it or take it
   *  away at any time. Absent is a machine that stays where it is. */
  formFactor?: "laptop";
}

/** Capabilities a daemon can prove from its host. A dispatch's required
 * capability outside this list stays guidance for the assignee: no machine
 * reports it, so requiring it would only refuse every launch. */
export const HOST_OBSERVED_CAPABILITIES = ["github"] as const;

/** The required capabilities a launch must find in its daemon's host evidence. */
export function hostObservedRequirements(required: readonly string[]): string[] {
  return [...new Set(required.filter(capability =>
    (HOST_OBSERVED_CAPABILITIES as readonly string[]).includes(capability)))].sort();
}

export function machineResourceObservation(value: unknown, now: number): MachineResourceObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const observed = typeof row.observedAt === "string" ? Date.parse(row.observedAt) : NaN;
  // Age is not staleness: the daemon reports a change when one happens, and
  // Authority keeps only the observation of its live connection.
  if (!Number.isFinite(observed) || observed > now) return undefined;
  const result: MachineResourceObservation = { observedAt: new Date(observed).toISOString() };
  for (const key of ["cpuLogicalCount", "memoryTotalBytes", "memoryAvailableBytes",
    "swapTotalBytes", "swapFreeBytes", "diskTotalBytes", "diskAvailableBytes"] as const) {
    const minimum = key === "memoryAvailableBytes" || key === "swapFreeBytes" || key === "diskAvailableBytes" ? 0 : 1;
    if (typeof row[key] === "number" && Number.isSafeInteger(row[key]) && row[key] >= minimum) result[key] = row[key];
  }
  if (typeof row.cpuUsagePercent === "number" && Number.isFinite(row.cpuUsagePercent) && row.cpuUsagePercent >= 0 && row.cpuUsagePercent <= 100) result.cpuUsagePercent = row.cpuUsagePercent;
  const load = row.loadAverage;
  if (Array.isArray(load) && load.length === 3 && load.every(value =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000)) {
    result.loadAverage = [load[0], load[1], load[2]];
  }
  // A free amount larger than its total is not a usable measurement.
  for (const [free, total] of [["memoryAvailableBytes", "memoryTotalBytes"],
    ["swapFreeBytes", "swapTotalBytes"], ["diskAvailableBytes", "diskTotalBytes"]] as const) {
    if (result[free] !== undefined && result[total] !== undefined && result[free] > result[total]) delete result[free];
  }
  if (Array.isArray(row.hostCapabilities) && row.hostCapabilities.length <= 16 &&
      row.hostCapabilities.every(value => typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/u.test(value))) {
    result.hostCapabilities = [...new Set(row.hostCapabilities as string[])].sort();
  }
  if (row.formFactor === "laptop") result.formFactor = "laptop";
  return Object.keys(result).length > 1 ? result : undefined;
}

export interface AgentRoutingRequirements {
  parameters?: Record<string, string>;
  model: string;
  machineId?: string;
  effort?: string;
  /** Optional capability constraint; never a selected machine or Agent. */
  harness?: string;
  unattended: boolean;
  requiredCapabilities: string[];
  /** Explicit duration requirement; never a model's promised completion time. */
  availableThrough?: string;
}

export const ROUTING_EXCLUSIONS = [
  "disabled", "wrong_space", "model_unsupported", "harness_mismatch", "machine_mismatch",
  "effort_unsupported", "machine_unreachable", "unattended_unavailable",
  "availability_window", "capability_unavailable", "execution_unsupported",
] as const;
export type AgentRoutingExclusion = typeof ROUTING_EXCLUSIONS[number];

/** What a reader can see about one environment in a routing decision. */
export interface RoutingChoiceRow {
  quotaObservation?: { status: "fresh" | "stale" | "unknown"; observedAt?: string; expiresAt?: string; source?: RoutingObservation<number>["source"] };
  harness: string;
  machineId: string;
  label?: string;
  machineLabel?: string;
  ownerLabel?: string;
  remainingQuota?: number;
  quotaAssumed?: boolean;
  activeRuns: number;
  machineActiveRuns?: number;
  machineResources?: MachineResourceObservation;
  lastSpawnFailureAt?: string;
  selected: boolean;
  excluded?: AgentRoutingExclusion[];
}

const EXCLUSION_LABEL: Record<AgentRoutingExclusion, string> = {
  machine_unreachable: "machine daemon unreachable",
  disabled: "turned off",
  wrong_space: "different space",
  model_unsupported: "model not declared",
  harness_mismatch: "different harness",
  machine_mismatch: "different machine",
  effort_unsupported: "effort not supported",
  unattended_unavailable: "needs someone present",
  availability_window: "outside its available hours",
  capability_unavailable: "missing a required capability",
  execution_unsupported: "harness cannot be started",
};

const HARNESS_LABEL: Record<string, string> = {
  codex: "Codex", claude: "Claude Code", claude_code: "Claude Code", grok: "Grok",
  opencode: "OpenCode", cursor: "Cursor", "cursor-agent": "Cursor", kimi: "Kimi", zcode: "ZCode",
  copilot: "Copilot", gemini: "Gemini", qwen: "Qwen Code", goose: "goose", junie: "Junie",
  vibe: "Mistral Vibe", kiro: "Kiro", hermes: "Hermes", openclaw: "OpenClaw",
};

export function boundedRoutingLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = replaceControlCharacters(value, " ").replace(/\s+/gu, " ").trim();
  if (!text) return undefined;
  return text.length > 80 ? text.slice(0, 80) : text;
}

export function routingHarnessLabel(harness: string): string {
  return HARNESS_LABEL[harness] ?? harness.replace(/[_-]+/gu, " ");
}

export function routingExclusionText(reasons: readonly string[]): string {
  return reasons.map(reason => EXCLUSION_LABEL[reason as AgentRoutingExclusion] ?? reason).join(", ");
}

export function routingChoiceIdentity(row: Pick<RoutingChoiceRow, "label" | "harness" | "machineLabel" | "machineId" | "ownerLabel">): string {
  const harness = routingHarnessLabel(row.harness);
  const name = row.label ? `${row.label} · ${harness}` : harness;
  const owner = row.ownerLabel && row.ownerLabel !== row.label ? row.ownerLabel : undefined;
  return [name, row.machineLabel || row.machineId, owner].filter(Boolean).join(" · ");
}

export function routingQuotaText(row: Pick<RoutingChoiceRow, "remainingQuota" | "quotaAssumed">): string {
  return row.remainingQuota === undefined || row.quotaAssumed
    ? "Quota unknown" : `${row.remainingQuota}% left`;
}

/** User-specified identity constraints define the visible decision domain. */
export function visibleRoutingChoiceRows(rows: readonly RoutingChoiceRow[]): RoutingChoiceRow[] {
  return rows.filter(row => !row.excluded?.some(reason =>
    reason === "machine_mismatch" || reason === "harness_mismatch"));
}

export const ROUTING_DECISION_SOURCES = ["deterministic", "jev", "jev-abstained", "jev-unavailable"] as const;
export type RoutingDecisionSource = typeof ROUTING_DECISION_SOURCES[number];

/** The Machine headroom routing bound this launch to. `name` is the owner's name, never a hostname. */
export interface RoutingBoundMachine { id: string; name?: string }

export interface PresentedRoutingDecision {
  parameters?: LaunchParameterEvidence;
  source: RoutingDecisionSource;
  rows: RoutingChoiceRow[];
  evaluatedAt?: string;
  candidateCount?: number;
  fallbackReason?: "jev-abstained" | "jev-unavailable";
  /** Why the selection service failed; a failed decision never renders without its cause. */
  failureCode?: string;
  /** Present once routing has bound a Machine. Absent on decisions recorded before that. */
  machine?: RoutingBoundMachine;
}

const ROUTING_FAILURE_TEXT: Record<string, string> = {
  timeout: "Jev did not answer within the decision budget.",
  jev_aborted: "Jev did not answer within the decision budget.",
  jev_invalid_input: "Jev rejected the decision input.",
  jev_customer_verification_required: "The Jev account requires customer verification.",
  jev_auth_failed: "Jev authentication failed.",
  jev_permission_denied: "Jev denied permission for this decision.",
  jev_rate_limited: "Jev rate-limited the decision.",
  jev_evaluation_failed: "Jev reported an evaluation failure.",
  invalid_answer: "Jev returned an answer that did not name a listed environment.",
  evaluator_unconfigured: "No Jev evaluator is configured on this Hub.",
  internal_error: "The Hub failed while preparing or reading the decision.",
};

export function routingFailureText(code: string | undefined): string {
  if (!code) return "Cause: not recorded.";
  return `Cause (${code}): ${ROUTING_FAILURE_TEXT[code] ?? "unrecognized failure code."}`;
}

export function parseRoutingFailureCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z_]{1,64}$/u.test(value) ? value : undefined;
}

export function routingDecisionCopy(decision: { source: string; rows?: readonly RoutingChoiceRow[]; failureCode?: string }): { verdict: string; rule: string } {
  const rows = visibleRoutingChoiceRows(decision.rows ?? []);
  const selected = rows.find(row => row.selected);
  const rule = decision.source === "jev"
    ? "Jev chose what suits the work; the matching environment with the most measured headroom runs it. Process startup is confirmed separately in the timeline. Only environments matching the explicit identity constraints are shown."
    : "This snapshot records candidates and constraint checks. Selection and process startup are recorded separately. Only environments matching the explicit identity constraints are shown.";
  if (selected) {
    const quota = selected.remainingQuota !== undefined && !selected.quotaAssumed
      ? `${selected.remainingQuota}% of its provider quota was left.`
      : "Provider quota was not measured.";
    const who = routingChoiceIdentity(selected);
    return { rule, verdict: decision.source === "jev"
      ? `Jev chose ${who}. ${quota}`
      : `Recorded selection: ${who}. ${quota}` };
  }
  const checked = `${rows.length} environment${rows.length === 1 ? " was" : "s were"} checked.`;
  return { rule, verdict: decision.source === "jev-unavailable"
    ? `The environment selection service failed. No Agent was started. ${routingFailureText(decision.failureCode)} ${checked}`
    : decision.source === "jev-abstained"
      ? `Jev did not return a usable choice. No Agent was started. ${checked}`
      : `No eligible environment matched this summon. No Agent was started. ${checked}` };
}

const presentedTimestamp = (value: unknown) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : undefined;

function presentRoutingChoiceRow(value: unknown, evaluatedAt?: string): RoutingChoiceRow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const harness = boundedRoutingLabel(row.harness);
  const machineId = typeof row.machineId === "string" ? replaceControlCharacters(row.machineId).trim() : "";
  if (!harness || !machineId || machineId.length > 300) return undefined;
  const activeRuns = Number(row.activeRuns);
  if (!Number.isSafeInteger(activeRuns) || activeRuns < 0) return undefined;
  const remaining = typeof row.remainingQuota === "number" && Number.isFinite(row.remainingQuota) &&
    row.remainingQuota >= 0 && row.remainingQuota <= 100 ? row.remainingQuota : undefined;
  const excluded = Array.isArray(row.excluded)
    ? row.excluded.filter((reason): reason is AgentRoutingExclusion =>
      typeof reason === "string" && (ROUTING_EXCLUSIONS as readonly string[]).includes(reason))
    : undefined;
  const machineActiveRuns = typeof row.machineActiveRuns === "number" && Number.isSafeInteger(row.machineActiveRuns) && row.machineActiveRuns >= 0 ? row.machineActiveRuns : undefined;
  const machineResources = evaluatedAt ? machineResourceObservation(row.machineResources, Date.parse(evaluatedAt)) : undefined;
  const observation = row.quotaObservation && typeof row.quotaObservation === "object" ? row.quotaObservation as Record<string, unknown> : {};
  const status = observation.status === "fresh" || observation.status === "stale" || observation.status === "unknown" ? observation.status : undefined;
  const source = observation.source === "daemon" || observation.source === "provider" || observation.source === "launch-authority" ? observation.source : undefined;
  const quotaObservation: RoutingChoiceRow["quotaObservation"] = status ? { status, ...(source ? { source } : {}),
    ...(presentedTimestamp(observation.observedAt) ? { observedAt: presentedTimestamp(observation.observedAt) } : {}),
    ...(presentedTimestamp(observation.expiresAt) ? { expiresAt: presentedTimestamp(observation.expiresAt) } : {}) } : undefined;
  const label = boundedRoutingLabel(row.label);
  const machineLabel = boundedRoutingLabel(row.machineLabel);
  const ownerLabel = boundedRoutingLabel(row.ownerLabel);
  return {
    harness, machineId,
    ...(label ? { label } : {}), ...(machineLabel ? { machineLabel } : {}), ...(ownerLabel ? { ownerLabel } : {}),
    ...(remaining !== undefined ? { remainingQuota: remaining } : {}),
    ...(row.quotaAssumed === true && remaining === 100 ? { quotaAssumed: true } : {}),
    ...(machineActiveRuns !== undefined ? { machineActiveRuns } : {}),
    ...(machineResources ? { machineResources } : {}),
    ...(evaluatedAt && typeof row.lastSpawnFailureAt === "string" &&
      Number.isFinite(Date.parse(row.lastSpawnFailureAt)) && Date.parse(row.lastSpawnFailureAt) <= Date.parse(evaluatedAt)
      ? { lastSpawnFailureAt: new Date(row.lastSpawnFailureAt).toISOString() } : {}),
    ...(quotaObservation ? { quotaObservation } : {}),
    activeRuns, selected: row.selected === true,
    ...(excluded?.length ? { excluded } : {}),
  };
}

/** A bound Machine is absent or well-formed. A bad one is dropped; it does not hide the rest of the decision. */
function presentedMachine(value: unknown): RoutingBoundMachine | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = typeof (value as { id?: unknown }).id === "string"
    ? replaceControlCharacters((value as { id: string }).id).trim() : "";
  if (!id || id.length > 300) return undefined;
  const name = boundedRoutingLabel((value as { name?: unknown }).name);
  return { id, ...(name ? { name } : {}) };
}

export function parsePresentedRoutingDecision(value: unknown): PresentedRoutingDecision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = (value as { source?: unknown }).source;
  if (typeof source !== "string" || !(ROUTING_DECISION_SOURCES as readonly string[]).includes(source)) return undefined;
  const evidence = value as Record<string, unknown>;
  const machine = presentedMachine(evidence.machine);
  const evaluatedAt = presentedTimestamp(evidence.evaluatedAt);
  const candidateCount = typeof evidence.candidateCount === "number" && Number.isSafeInteger(evidence.candidateCount) && evidence.candidateCount >= 0 && evidence.candidateCount <= 100 ? evidence.candidateCount : undefined;
  const fallbackReason = evidence.fallbackReason === "jev-abstained" || evidence.fallbackReason === "jev-unavailable" ? evidence.fallbackReason : undefined;
  const failureCode = parseRoutingFailureCode(evidence.failureCode);
  const raw = evidence.rows;
  const rows = Array.isArray(raw) ? raw.slice(0, 100).flatMap(item => {
    const row = presentRoutingChoiceRow(item, evaluatedAt);
    return row ? [row] : [];
  }) : [];
  return { source: source as RoutingDecisionSource, rows, evaluatedAt, candidateCount, fallbackReason,
    ...(failureCode ? { failureCode } : {}),
    ...(machine ? { machine } : {}),
    ...(parseLaunchParameterEvidence(evidence.parameters) ? { parameters: parseLaunchParameterEvidence(evidence.parameters) } : {}) };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid routing object");
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error("Invalid routing text");
  }
  return value.trim();
}

function timestamp(value: unknown): string {
  const result = boundedText(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error("Routing timestamps must be UTC");
  }
  return result;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unknown routing field");
}

export function parseAgentRoutingDeclaration(value: unknown): AgentRoutingDeclaration {
  const row = configurationFields(value, ["schemaVersion", "enabled", "models", "description", "availability", "availableUntil",
    "capabilities", "defaultWorkspace", "modelAliases", "quotaPoolId"], "Agent routing declaration");
  if (row.schemaVersion !== 1 || typeof row.enabled !== "boolean" ||
      !["interactive", "unattended", "unknown"].includes(String(row.availability)) ||
      !Array.isArray(row.models) || row.models.length > 32 ||
      !Array.isArray(row.capabilities) || row.capabilities.length > 32) throw new Error("Invalid routing declaration");
  const models = row.models.map(item => boundedText(item, 160));
  const modelAliases = row.modelAliases === undefined ? undefined : Object.fromEntries(
    Object.entries(object(row.modelAliases)).map(([key, value]) => {
      if (!models.includes(key)) throw new Error("Model alias must refer to a declared model");
      return [key, boundedText(value, 160)];
    }));
  const capabilities = row.capabilities.map(item => {
    const capability = object(item);
    keys(capability, ["key", "description", "expiresAt"]);
    const key = boundedText(capability.key, 80);
    if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(key)) throw new Error("Invalid routing capability key");
    return { key, description: boundedText(capability.description, 300), expiresAt: timestamp(capability.expiresAt) };
  });
  if (new Set(models).size !== models.length || new Set(capabilities.map(item => item.key)).size !== capabilities.length) {
    throw new Error("Duplicate routing entry");
  }
  return { schemaVersion: 1, enabled: row.enabled, models,
    ...(modelAliases ? { modelAliases } : {}),
    description: typeof row.description === "string" && row.description.length <= 1_000
      ? row.description.trim() : (() => { throw new Error("Invalid routing description"); })(),
    availability: row.availability as AgentRoutingDeclaration["availability"],
    ...(row.availableUntil === undefined ? {} : { availableUntil: timestamp(row.availableUntil) }),
    ...(row.defaultWorkspace === undefined ? {} : { defaultWorkspace: boundedText(row.defaultWorkspace, 4_000) }),
    ...(row.quotaPoolId === undefined ? {} : { quotaPoolId: boundedText(row.quotaPoolId, 300) }),
    capabilities };
}

export function parseAgentRoutingRequirements(value: unknown): AgentRoutingRequirements {
  const row = object(value);
  keys(row, ["model", "harness", "machineId", "effort", "parameters", "unattended", "requiredCapabilities", "availableThrough"]);
  if (typeof row.unattended !== "boolean" || !Array.isArray(row.requiredCapabilities) ||
      row.requiredCapabilities.length > 32) throw new Error("Invalid routing requirements");
  return { ...(row.parameters === undefined ? {} : { parameters: parseHarnessParameterValues(row.parameters) }), model: !row.model ? "" : boundedText(row.model, 160), unattended: row.unattended,
    ...(row.machineId === undefined ? {} : { machineId: boundedText(row.machineId, 160) }),
    ...(row.effort === undefined ? {} : { effort: boundedText(row.effort, 80) }),
    ...(row.harness === undefined ? {} : { harness: canonicalRegistrationHarness(row.harness) }),
    requiredCapabilities: [...new Set(row.requiredCapabilities.map(item => boundedText(item, 80)))],
    ...(row.availableThrough === undefined ? {} : { availableThrough: timestamp(row.availableThrough) }) };
}

/**
 * A provider quota reading is a persisted snapshot: it stays readable while no
 * Instance is connected, so an idle environment is not automatically unknown.
 * Positive balances expire after a bounded age. An exhausted window with a
 * provider reset remains a negative signal until that reset (bounded to 31 days).
 * Expiring one window must not erase another window's exhaustion.
 *
 * The provider's own verdict on the account outranks its windows: an account
 * it refuses has no headroom whatever the windows say, and one it still serves
 * past a used-up window (credits) keeps the least headroom that is still some,
 * so it stays eligible but ranks after every account with window headroom.
 */
export const ROUTING_QUOTA_MAX_AGE_MS = 15 * 60_000;
const ROUTING_EXHAUSTED_MAX_AGE_MS = 31 * 24 * 60 * 60_000;
const ROUTING_SERVED_PAST_LIMIT_REMAINING = 1;

/** A provider reset as epoch milliseconds, NaN when it is not a time. */
export function routingQuotaResetTime(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") return NaN;
  const numeric = Number(value);
  if (String(value).trim() && Number.isFinite(numeric)) {
    // LlmQuotaUsage.resetAt uses provider Unix seconds; accept ISO timestamps
    // too, as supplied by other provider adapters.
    return numeric * 1000;
  }
  return typeof value === "string" ? Date.parse(value) : NaN;
}

export function routingQuotaObservation(usage: unknown, now: number): RoutingObservation<number> | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage) || !Number.isFinite(now)) return undefined;
  const row = usage as Record<string, unknown>;
  // Runtime usage marks provider reads as `provider_api`; local session estimates never qualify.
  if (row.quotaSource !== "provider_api") return undefined;
  const observed = typeof row.quotaObservedAt === "string" ? Date.parse(row.quotaObservedAt) : NaN;
  if (!Number.isFinite(observed) || observed > now) return undefined;
  const windows = Array.isArray(row.quotaUsages) ? row.quotaUsages : [];
  const allowed = parseLlmQuotaAccount(row.quotaAccount)?.allowed;
  const readings: Array<{ remaining: number; expires: number }> = [];
  for (const value of windows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const window = value as Record<string, unknown>;
    // percent is the provider's 0..100 usage; remaining is not an inferred balance.
    if (typeof window.percent !== "number" || !Number.isFinite(window.percent) ||
        window.percent < 0 || window.percent > 100) continue;
    const reset = routingQuotaResetTime(window.resetAt ?? window.reset_at);
    if (Number.isFinite(reset) && reset <= now) continue;
    const hasReset = Number.isFinite(reset) && reset > observed;
    const maxAge = window.percent === 100 && hasReset && allowed !== true
      ? ROUTING_EXHAUSTED_MAX_AGE_MS : ROUTING_QUOTA_MAX_AGE_MS;
    const expires = Math.min(observed + maxAge, hasReset ? reset : Infinity);
    if (expires > now) readings.push({ remaining: 100 - window.percent, expires });
  }
  if (!readings.length) return undefined;
  const exhausted = readings.filter(reading => reading.remaining === 0);
  const expires = exhausted.length && allowed !== true ? Math.max(...exhausted.map(reading => reading.expires))
    : Math.min(...readings.map(reading => reading.expires));
  const windowRemaining = Math.min(...readings.map(reading => reading.remaining));
  const value = allowed === false ? 0
    : allowed === true ? Math.max(windowRemaining, ROUTING_SERVED_PAST_LIMIT_REMAINING) : windowRemaining;
  return { value, observedAt: new Date(observed).toISOString(),
    expiresAt: new Date(expires).toISOString(), source: "provider" };
}
