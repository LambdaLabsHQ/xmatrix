import { parseAgentControlCommands as parseProductAgentControlCommands,
  type AgentControlCommand as ProductAgentControlCommand, type AgentControlOutcomeRecord,
  type AgentControlKind as ProductAgentControlKind } from "@xmatrix/protocol";
export { parseProductAgentControlCommands };
export type { ProductAgentControlCommand, ProductAgentControlKind };

/**
 * Runtime-internal route for one switch. It lives with the command rather than
 * in the Durable Object so the Core-side caller never has to import the DO.
 */
export const RELAY_RUNTIME_AGENT_CONTROL_SWITCH_PATH = "/internal/product-agent/control-switch";

export type ProductAgentControlOutcome =
  | { status: "switched"; selected: string;
      /** The switch cancelled this Instance's running turn under `requestId`. */
      continuation?: { instanceId: string; requestId: string } }
  | { status: "catalog"; current?: string; options: readonly string[] }
  | { status: "no_instance" }
  | { status: "error"; message: string;
      /** A refused switch still cancelled this Instance's running turn. */
      continuation?: { instanceId: string; requestId: string } };

export interface ProductAgentControlPort {
  switchControl(input: {
    channelId: string;
    target: string;
    kind: ProductAgentControlKind;
    value?: string;
  }): Promise<ProductAgentControlOutcome>;
  /** The receipt is the text an Agent reads; `outcomes` are what a client
   * hangs on each written statement, in statement order. */
  publishSystemNotice(channelId: string, body: string, outcomes: readonly AgentControlOutcomeRecord[]): Promise<void>;
  /** Commit the instruction that one Instance continue the turn its switches cancelled. */
  publishContinuation?(channelId: string, input: { instanceId: string; requestIds: string[]; body: string }): Promise<void>;
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
    case "switched": return { ...statement, status: "switched", selected: outcome.selected };
    case "catalog": return { ...statement, status: "catalog", options: [...outcome.options],
      ...(outcome.current ? { current: outcome.current } : {}) };
    case "no_instance": return { ...statement, status: "no_instance" };
    case "error": return { ...statement, status: "error", message: outcome.message };
  }
}

function noticeForOutcome(
  command: ProductAgentControlCommand,
  outcome: ProductAgentControlOutcome,
): string {
  const label = `@${command.target}`;
  const noun = command.kind === "model" ? "model" : "effort";
  switch (outcome.status) {
    case "switched":
      // A switch preempts like any other steering so it takes effect at once;
      // the Instance then resumes the work it cancelled, on the new selection,
      // unless a newer message is waiting to be the next turn instead.
      return `Switched ${label} to \`${outcome.selected}\`. A turn that was running`
        + ` is interrupted and continues on it.`;
    case "catalog": {
      if (outcome.options.length === 0) {
        return `${label} has not reported a ${noun} catalog.`;
      }
      const visible = outcome.options.slice(0, 25).map((option) => `\`${option}\``).join(", ");
      const remaining = outcome.options.length > 25
        ? `, and ${outcome.options.length - 25} more`
        : "";
      const current = outcome.current ? ` Current: \`${outcome.current}\`.` : "";
      return `Available ${noun}s for ${label}: ${visible}${remaining}.${current}`
        + ` Use \`${label} /${noun} <${noun}>\` to switch.`;
    }
    case "no_instance":
      return `xMatrix could not find a live instance for \`${label}\`.`
        + ` Use \`@<agent>:<channel-instance-number> /${noun} <${noun}>\`.`;
    case "error":
      return `Could not switch the ${noun} for ${label}: ${outcome.message}`;
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
  const notices: string[] = [];
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
    notices.push(noticeForOutcome(command, outcome));
  }

  /* One decision, one receipt. A bullet per statement keeps a partial failure
     readable without turning a two-tag edit into two system messages. */
  await input.port.publishSystemNotice(
    input.channelId,
    notices.length === 1
      ? notices[0]!
      : notices.map((notice) => `- ${notice}`).join("\n"),
    results.map(({ outcome }, index) => outcomeRecord(commands[index]!, outcome)),
  );
  /* A turn a switch cancelled continues on what is selected now, once per
     Instance after every statement has landed: the first switch cancels the
     turn and the next must not cancel its continuation again. */
  if (input.port.publishContinuation) {
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
      await input.port.publishContinuation(input.channelId, { instanceId, requestIds,
        body: switchContinuationPrompt(selections) });
    }
  }
  return results;
}
