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

/**
 * Every statement in the message, or none at all.
 *
 * A message that mixes a switch with prose is not a control message: the
 * addressed Instance still has to read the prose, and executing half of it
 * while delivering the other half as work would be two different answers to
 * the same message.
 */
export function parseAgentControlCommands(
  body: string,
): AgentControlCommand[] {
  if (body.length > MESSAGE_INTERACTION_LIMITS.bodyLength) return [];
  const lines = body.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > AGENT_CONTROL_STATEMENT_LIMIT) return [];
  const commands: AgentControlCommand[] = [];
  for (const line of lines) {
    const command = parseControlStatement(line);
    if (!command) return [];
    commands.push(command);
  }
  // The Markdown context check parses the whole body, so it runs only for a
  // message whose every line already reads as a statement.
  const ranges = nonOperationalMentionRanges(body);
  let offset = 0;
  for (const line of body.split(/\n/u)) {
    if (line.trim() && !isOperationalMentionStart(offset + line.search(/\S/u), ranges)) return [];
    offset += line.length + 1;
  }
  return commands;
}
