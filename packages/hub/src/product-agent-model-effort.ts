import { parseAgentControlCommands as parseProductAgentControlCommands,
  type AgentControlCommand as ProductAgentControlCommand,
  type AgentControlKind as ProductAgentControlKind } from "@xmatrix/protocol";
export { parseProductAgentControlCommands };
export type { ProductAgentControlCommand, ProductAgentControlKind };

/**
 * Runtime-internal route for one switch. It lives with the command rather than
 * in the Durable Object so the Core-side caller never has to import the DO.
 */
export const RELAY_RUNTIME_AGENT_CONTROL_SWITCH_PATH = "/internal/product-agent/control-switch";

export type ProductAgentControlOutcome =
  | { status: "switched"; selected: string }
  | { status: "catalog"; current?: string; options: readonly string[] }
  | { status: "no_instance" }
  | { status: "error"; message: string };

export interface ProductAgentControlPort {
  switchControl(input: {
    channelId: string;
    target: string;
    kind: ProductAgentControlKind;
    value?: string;
  }): Promise<ProductAgentControlOutcome>;
  publishSystemNotice(channelId: string, body: string): Promise<void>;
}

export interface ProductAgentControlResult {
  kind: ProductAgentControlKind;
  outcome: ProductAgentControlOutcome;
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
  );
  return results;
}
