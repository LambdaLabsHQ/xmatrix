import { isOperationalMentionStart, nonOperationalMentionRanges } from "./operational-mention-context.js";
import { matchInteractionGrammar, MESSAGE_INTERACTION_LIMITS } from "./message-interaction-grammar.js";

export type AgentControlKind = "model" | "effort";

export interface AgentControlCommand {
  kind: AgentControlKind;
  /** `<agent-name>:<channel-instance-number>`, exactly as the human typed it. */
  target: string;
  /** Absent means "list what this Instance offers" rather than "switch". */
  value?: string;
}

/** Ceiling on one message so a pasted transcript cannot become a switch storm. */
const AGENT_CONTROL_STATEMENT_LIMIT = MESSAGE_INTERACTION_LIMITS.statements;

function parseControlStatement(line: string): AgentControlCommand | undefined {
  for (const [kind, rule] of [["model", "runtime.model.v1"], ["effort", "runtime.effort.v1"]] as const) {
    const match = matchInteractionGrammar(rule, line)[0];
    if (!match) continue;
    return { kind, target: match.arguments.target!,
      ...(match.arguments.value ? { value: match.arguments.value.slice(0, 128) } : {}) };
  }
  return undefined;
}

/** One statement as it was written, so a client can hang its result on that
 * span instead of the Hub posting another message. Offsets are UTF-16
 * positions in the body. */
export interface AgentControlInvocation extends AgentControlCommand {
  start: number;
  end: number;
  text: string;
}

/** What one statement came to, in statement order on the Hub's receipt. */
export type AgentControlOutcomeRecord = Pick<AgentControlCommand, "kind" | "target"> & (
  | { status: "switched"; selected: string }
  | { status: "catalog"; current?: string; options: string[] }
  | { status: "no_instance" }
  | { status: "error"; message: string });

/**
 * Every statement in the message, or none at all.
 *
 * A message that mixes a switch with prose is not a control message: the
 * addressed Instance still has to read the prose, and executing half of it
 * while delivering the other half as work would be two different answers to
 * the same message.
 */
export function parseAgentControlInvocations(
  body: string,
): AgentControlInvocation[] {
  if (body.length > MESSAGE_INTERACTION_LIMITS.bodyLength) return [];
  const lines = body.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > AGENT_CONTROL_STATEMENT_LIMIT) return [];
  const invocations: AgentControlInvocation[] = [];
  let offset = 0;
  for (const line of body.split(/\n/u)) {
    const text = line.trim();
    if (text) {
      const command = parseControlStatement(text);
      if (!command) return [];
      const start = offset + line.search(/\S/u);
      invocations.push({ ...command, start, end: start + text.length, text });
    }
    offset += line.length + 1;
  }
  // The Markdown context check parses the whole body, so it runs only for a
  // message whose every line already reads as a statement.
  const ranges = nonOperationalMentionRanges(body);
  return invocations.every((invocation) => isOperationalMentionStart(invocation.start, ranges)) ? invocations : [];
}

export function parseAgentControlCommands(body: string): AgentControlCommand[] {
  return parseAgentControlInvocations(body).map(({ kind, target, value }) => ({ kind, target, ...(value ? { value } : {}) }));
}
