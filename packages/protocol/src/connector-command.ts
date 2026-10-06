import { isOperationalMentionStart, nonOperationalMentionRanges } from "./operational-mention-context.js";
import { matchInteractionGrammar } from "./message-interaction-grammar.js";

export interface ParsedConnectorActionCommand {
  actionId: string;
  statement: { target: string; text: string };
}

/** Provider names are values, never interpolated into a regular expression.
 * The syntax belongs to the protocol; action validation belongs to the provider. */
export function parseConnectorActionCommand(providerId: string, body: string): ParsedConnectorActionCommand | undefined {
  if (!isOperationalMentionStart(body.search(/\S/u), nonOperationalMentionRanges(body))) return undefined;
  const normalized = body.trim().replace(/^[\u200B-\u200D\uFEFF]*/u, "")
    .replace(/^([@＠])[\u200B-\u200D\uFEFF]*/u, "$1");
  const [first = "", ...rest] = normalized.split(/\r?\n/u);
  const parsed = matchInteractionGrammar("connector.action.v1", first.trim())[0];
  if (!parsed || parsed.arguments.provider!.toLowerCase() !== providerId.toLowerCase()) return undefined;
  return { actionId: parsed.arguments.action!.toLowerCase(), statement: {
    target: parsed.arguments.target ?? "", text: [parsed.arguments.text?.trim() ?? "", ...rest].join("\n").trim() } };
}
