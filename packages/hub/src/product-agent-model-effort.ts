import { parseAgentControlCommands as parseProductAgentControlCommands, routingModelOptionNamed, routingQuotaObservation,
  type AgentControlCommand as ProductAgentControlCommand, type AgentControlOutcomeRecord,
  type AgentControlQuotaExhausted, type AgentControlUsedUpOption,
  type AgentControlKind as ProductAgentControlKind, type RoutingModelOption } from "@xmatrix/protocol";
export { parseProductAgentControlCommands };
export type { ProductAgentControlCommand, ProductAgentControlKind };

/**
 * Runtime-internal route for one switch. It lives with the command rather than
 * in the Durable Object so the Core-side caller never has to import the DO.
 */
export const RELAY_RUNTIME_AGENT_CONTROL_SWITCH_PATH = "/internal/product-agent/control-switch";
/** Runtime-internal route that hands one Instance its switch continuation. */
export const RELAY_RUNTIME_AGENT_SWITCH_CONTINUATION_PATH = "/internal/product-agent/switch-continuation";
/** A runtime that takes its continuation as a frame, not as a Channel message. */
export const SWITCH_CONTINUATION_FRAME_CAPABILITY = "switch_continuation_frame";

export type ProductAgentControlOutcome =
  | { status: "switched"; selected: string;
      /** Recorded for a resting Instance: it starts on `selected` when it wakes. */
      onWake?: true;
      /** The switch cancelled this Instance's running turn under `requestId`. */
      continuation?: { instanceId: string; requestId: string } }
  | { status: "catalog"; current?: string; options: readonly string[]; usedUp?: AgentControlUsedUpOption[] }
  | { status: "no_instance" }
  | { status: "error"; message: string; quotaExhausted?: AgentControlQuotaExhausted; starting?: true;
      /** A refused switch still cancelled this Instance's running turn. */
      continuation?: { instanceId: string; requestId: string } };

/** What the Hub's own records say about the Instance a statement addresses. */
export interface ProductAgentSwitchTarget {
  state: "starting" | "running" | "asleep" | "stopped";
  agentName?: string;
  machineName?: string;
  currentModel?: string;
  /** The runtime's catalog as the Instance row stores it. */
  reportedModels?: unknown[];
  /** That catalog while it is fresh enough to decide quota by. */
  modelCatalog?: RoutingModelOption[];
  /** The provider's reading of the Instance's account. */
  usage?: unknown;
  harness?: string;
  /** Other Machines that run its harness and could take over its work, each
   * with its own account's reading. */
  elsewhere?: Array<{ machineName: string; usage: unknown }>;
}

/** `2026-11-19 18:00 UTC`: a reset as every refusal writes it. */
function utcMinute(at: string): string {
  return `${new Date(Date.parse(at)).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** When the provider quota of one catalog model is back, while a current
 * reading shows it used up; undefined while it has quota or nothing was read. */
function usedUpUntil(target: ProductAgentSwitchTarget, row: RoutingModelOption, now: number): string | undefined {
  const quota = routingQuotaObservation(target.usage, now, { model: row });
  return quota !== undefined && quota.value <= 0 && Date.parse(quota.expiresAt) > now ? quota.expiresAt : undefined;
}

/** The catalog models with quota left by a current reading, the runtime's
 * default first. Empty without a reading: nothing is promised unread. */
function modelsWithQuota(target: ProductAgentSwitchTarget, now: number): string[] {
  if (routingQuotaObservation(target.usage, now) === undefined) return [];
  return (target.modelCatalog ?? []).filter(row => !usedUpUntil(target, row, now))
    .sort((left, right) => Number(right.isDefault === true) - Number(left.isDefault === true)).map(row => row.model);
}

const onMachine = (target: ProductAgentSwitchTarget) => target.machineName ? ` on ${target.machineName}` : "";
const staysOn = (target: ProductAgentSwitchTarget, address: string) =>
  target.currentModel ? ` @${address} stays on ${target.currentModel}.` : ` @${address} keeps its model.`;

/** A provider's own refusal for quota, as a runtime passes it on. */
const PROVIDER_QUOTA_REFUSAL = /\b429\b|rate.?limit|usage.?limit|quota/iu;

/**
 * One statement decided against what the Hub knows of its Instance, around
 * the Runtime exchange `dispatch` performs:
 * - a model a current provider reading shows used up is refused here, saying
 *   until when, so the Instance's running turn is not interrupted for nothing;
 * - the Runtime is handed the Instance row's catalog, which a cell that lost
 *   its memory of the Instance no longer holds;
 * - an Instance no cell holds is named for what it is (starting, asleep,
 *   stopped) instead of as missing;
 * - a provider's quota refusal says whose account and which model;
 * - a listed catalog marks the models that are used up.
 */
export async function decideProductAgentSwitch(input: {
  command: ProductAgentControlCommand;
  target: ProductAgentSwitchTarget | undefined;
  now: number;
  /** `awaitStarting` asks the Runtime to wait for an Instance that has not reported yet. */
  dispatch(reportedModels: unknown[] | undefined, awaitStarting?: boolean): Promise<ProductAgentControlOutcome>;
  /** Record the model a resting Instance starts on when it next wakes:
   * the model recorded, or what it can start on when `written` is none of
   * them. Undefined when it stopped resting meanwhile. */
  chooseOnWake?(written: string): Promise<{ selected: string } | { offers: string[] } | undefined>;
}): Promise<ProductAgentControlOutcome> {
  const { command, now } = input;
  const name = command.target.replace(/:[1-9]\d*$/u, "");
  // A renamed Agent's row may still hold its old name: its facts are then not
  // provably this address's, and the Runtime alone answers.
  const target = input.target && (!input.target.agentName ||
    input.target.agentName.toLowerCase() === name.toLowerCase()) ? input.target : undefined;
  const live = target?.state === "starting" || target?.state === "running";
  const row = target && command.kind === "model" && command.value
    ? (target.modelCatalog ?? []).find(option => routingModelOptionNamed(option, command.value!)) : undefined;
  const quotaRefusal = (model: string, resetsAt: string | undefined): ProductAgentControlOutcome => {
    // Without a reading of the refused model's own quota, the models that
    // share its scopes cannot be told from it: none of them is promised.
    const scopes = new Set(resetsAt ? [] : (row?.quotaScopes ?? []).map(scope => scope.trim().toLowerCase()));
    const sharesScope = (option: string) => (target!.modelCatalog ?? []).some(candidate => candidate.model === option &&
      (candidate.quotaScopes ?? []).some(scope => scopes.has(scope.trim().toLowerCase())));
    const available = modelsWithQuota(target!, now).filter(option => option !== model && option !== target!.currentModel &&
      !sharesScope(option));
    // A Machine is named only when its own reading shows this model has quota
    // there, and the model can be written after `model:` as it is.
    const elsewhere = row && target!.harness && !/[\s"]/u.test(row.model) && !/"/u.test(target!.harness)
      ? (target!.elsewhere ?? []).filter(machine => !/"/u.test(machine.machineName) &&
        (routingQuotaObservation(machine.usage, now, { model: row })?.value ?? 0) > 0)
        .slice(0, 3).map(machine => ({ machineName: machine.machineName, harness: target!.harness! })) : [];
    return { status: "error",
      message: (resetsAt
        ? `the provider quota for ${model}${onMachine(target!)} is used up until ${utcMinute(resetsAt)}.`
        : `the provider account${onMachine(target!)} has no quota left for ${model}, and gave no reset time.`) +
        staysOn(target!, command.target),
      quotaExhausted: { model, ...(resetsAt ? { resetsAt } : {}),
        ...(target!.machineName ? { machineName: target!.machineName } : {}),
        ...(available.length ? { available } : {}), ...(elsewhere.length ? { elsewhere } : {}) } };
  };
  const asleep = target?.state === "asleep";
  if (target && (live || asleep) && row) {
    const resetsAt = usedUpUntil(target, row, now);
    if (resetsAt) return quotaRefusal(row.model, resetsAt);
  }
  let first = await input.dispatch(target?.reportedModels);
  if (!target) return first;
  // A resting Instance has no session to switch, and the person should not
  // have to come back when it wakes: the model is recorded and it starts on
  // it. Its models are listed from what it last reported.
  if (first.status === "no_instance" && asleep && command.kind === "model") {
    const offered = (target.modelCatalog ?? []).map(option => option.model);
    if (!command.value) {
      if (offered.length) first = { status: "catalog", options: offered, ...(target.currentModel ? { current: target.currentModel } : {}) };
    } else if (input.chooseOnWake) {
      const chosen = await input.chooseOnWake(command.value);
      if (chosen && "selected" in chosen) return { status: "switched", selected: chosen.selected, onWake: true };
      if (chosen?.offers.length) {
        return { status: "error", message: `\`${command.value}\` is not one @${command.target} can start on. ` +
          `It can start on ${chosen.offers.map(option => `\`${option}\``).join(", ")}.` };
      }
      // It woke while this was decided: it is asked like any live Instance.
      if (!chosen) first = await input.dispatch(target.reportedModels, true);
    }
  }
  // An Instance with a Run and no connection is starting, being reborn or
  // reconnecting: the statement waits for its next report and is applied
  // then, instead of being refused.
  const outcome = first.status === "no_instance" && live
    ? await input.dispatch(target.reportedModels, true) : first;
  if (outcome.status === "no_instance") {
    const address = `@${command.target}`;
    return { status: "error", message: target.state === "asleep"
      ? `${address} is asleep, so it has no session to switch. It wakes on its next message; send this again then.`
      : target.state === "stopped"
        ? `${address} has stopped. Start it again with ${address}:reborn, then send this again.`
        : target.state === "starting"
          ? `${address} is still starting${onMachine(target)} and did not come up while xMatrix waited. Send this again once it is running.`
          : `${address} is not connected to xMatrix right now${onMachine(target)} and did not come back while xMatrix waited. Send this again once it is back.`,
      ...(live ? { starting: true as const } : {}) };
  }
  if (outcome.status === "error" && command.kind === "model" && command.value && PROVIDER_QUOTA_REFUSAL.test(outcome.message)) {
    const refused = quotaRefusal(row?.model ?? command.value, undefined);
    return { ...refused, ...(outcome.continuation ? { continuation: outcome.continuation } : {}) };
  }
  if (outcome.status === "catalog" && command.kind === "model") {
    const usedUp = outcome.options.flatMap(option => {
      const listed = (target.modelCatalog ?? []).find(candidate => routingModelOptionNamed(candidate, option));
      const resetsAt = listed && usedUpUntil(target, listed, now);
      return resetsAt ? [{ option, resetsAt }] : [];
    });
    return usedUp.length ? { ...outcome, usedUp } : outcome;
  }
  return outcome;
}

export interface ProductAgentControlPort {
  switchControl(input: {
    channelId: string;
    target: string;
    kind: ProductAgentControlKind;
    value?: string;
  }): Promise<ProductAgentControlOutcome>;
  /** Record each statement's outcome, in statement order, on the message that wrote them. */
  recordOutcomes(channelId: string, outcomes: readonly AgentControlOutcomeRecord[]): Promise<void>;
  /** Tell one Instance to continue the turn its switches cancelled. */
  continueTurn?(channelId: string, input: { instanceId: string; requestIds: string[]; body: string }): Promise<void>;
}

/**
 * The input a continued turn starts from. Every harness needs input to start
 * inference, and the cancelled turn ends on the harness's own record of the
 * cancellation, which a model otherwise reads as a person rejecting its work.
 * So it says who cancelled the turn and why, and nothing else.
 */
export function switchContinuationPrompt(selections: readonly string[]): string {
  const cause = selections.length === 0
    ? "for a model or effort switch, which was not applied"
    : `so that the switch to ${selections.join(" and ")} took effect at once`;
  return `[xMatrix] xMatrix interrupted your previous turn ${cause}; no person interrupted or `
    + "rejected anything. A tool call cancelled by that interrupt may have partly run: check its side "
    + "effects before retrying it. Continue the interrupted work from where it stopped. If it was "
    + "already complete, end the turn without doing anything more.";
}

export interface ProductAgentControlResult {
  kind: ProductAgentControlKind;
  outcome: ProductAgentControlOutcome;
}

function outcomeRecord(command: ProductAgentControlCommand, outcome: ProductAgentControlOutcome): AgentControlOutcomeRecord {
  const statement = { kind: command.kind, target: command.target };
  switch (outcome.status) {
    case "switched": return { ...statement, status: "switched", selected: outcome.selected,
      ...(outcome.onWake ? { onWake: true } : {}) };
    case "catalog": return { ...statement, status: "catalog", options: [...outcome.options],
      ...(outcome.current ? { current: outcome.current } : {}), ...(outcome.usedUp?.length ? { usedUp: outcome.usedUp } : {}) };
    case "no_instance": return { ...statement, status: "no_instance" };
    case "error": return { ...statement, status: "error", message: outcome.message,
      ...(outcome.quotaExhausted ? { quotaExhausted: outcome.quotaExhausted } : {}),
      ...(outcome.starting ? { starting: true } : {}) };
  }
}

export async function orchestrateProductAgentControlCommands(input: {
  channelId: string;
  body: string;
  port: ProductAgentControlPort;
}): Promise<ProductAgentControlResult[]> {
  const commands = parseProductAgentControlCommands(input.body);
  if (commands.length === 0) return [];

  const results: ProductAgentControlResult[] = [];
  /* Sequentially: a model switch changes which efforts the Instance offers, so
     an effort statement written after one has to be resolved against the model
     that is live by then. */
  for (const command of commands) {
    let outcome: ProductAgentControlOutcome;
    try {
      outcome = await input.port.switchControl({
        channelId: input.channelId,
        target: command.target,
        kind: command.kind,
        ...(command.value ? { value: command.value } : {}),
      });
    } catch (error) {
      outcome = {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    results.push({ kind: command.kind, outcome });
  }

  /* One decision, one result, drawn on the statements that asked for it: it
     is not a message, so it neither previews, counts as unread nor wakes. */
  await input.port.recordOutcomes(input.channelId,
    results.map(({ outcome }, index) => outcomeRecord(commands[index]!, outcome)));
  /* A turn a switch cancelled continues on what is selected now, once per
     Instance after every statement has landed: the first switch cancels the
     turn and the next must not cancel its continuation again. */
  if (input.port.continueTurn) {
    const byTarget = new Map<string, { instanceId?: string; requestIds: string[]; selections: string[] }>();
    for (const [index, { kind, outcome }] of results.entries()) {
      if (outcome.status !== "switched" && outcome.status !== "error") continue;
      const target = commands[index]!.target.toLowerCase();
      const entry = byTarget.get(target) ?? { requestIds: [], selections: [] };
      if (outcome.status === "switched") entry.selections.push(`${kind} \`${outcome.selected}\``);
      if (outcome.continuation) {
        entry.instanceId = outcome.continuation.instanceId;
        entry.requestIds.push(outcome.continuation.requestId);
      }
      byTarget.set(target, entry);
    }
    for (const { instanceId, requestIds, selections } of byTarget.values()) {
      if (!instanceId) continue;
      await input.port.continueTurn(input.channelId, { instanceId, requestIds,
        body: switchContinuationPrompt(selections) });
    }
  }
  return results;
}
