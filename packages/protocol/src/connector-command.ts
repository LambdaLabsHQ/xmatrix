import { isOperationalMentionStart, nonOperationalMentionRanges } from "./operational-mention-context.js";
import { matchInteractionGrammar } from "./message-interaction-grammar.js";
import { APP_CONNECTOR_PROVIDER_MANIFESTS, type AppConnectorProviderManifest } from "./app-connector-manifests.js";

export interface ParsedConnectorActionCommand {
  actionId: string;
  statement: { target: string; text: string };
}

/** Provider names are values, never interpolated into a regular expression.
 * The syntax belongs to the protocol; action validation belongs to the provider. */
export function parseConnectorActionCommand(providerId: string, body: string): ParsedConnectorActionCommand | undefined {
  const written = parseConnectorStatement(body, providerId);
  if (!written) return undefined;
  return { actionId: written.invocation.action, statement: written.statement };
}

/** What a connector accepts as a command: its admin `policy`, subscriptions
 * when it delivers events, then every action its manifest declares. */
export function connectorOperationIds(manifest: AppConnectorProviderManifest | undefined): string[] {
  return [...new Set(["policy", ...(manifest?.events ? ["subscribe", "unsubscribe"] : []),
    ...(manifest?.actions.map(action => action.id) ?? [])])];
}

/** The command a message is, as the spans of its body that write it: the
 * whole first-line statement, the `@provider:action[:target]` command inside
 * it, and where its target sits. Offsets are into the body. */
export interface ConnectorInvocation {
  start: number; end: number; text: string;
  /** End of `@provider:action[:target]`; the arguments written after it follow. */
  commandEnd: number;
  target?: { start: number; end: number };
  provider: string; action: string;
}

/** A message is a connector command when its first line is one for a
 * connector the protocol knows: the same reading the Hub runs it by. */
export function parseConnectorInvocation(body: string): ConnectorInvocation | undefined {
  const written = parseConnectorStatement(body);
  if (!written) return undefined;
  const { invocation } = written;
  const manifest = APP_CONNECTOR_PROVIDER_MANIFESTS.find(candidate => candidate.id === invocation.provider);
  return manifest && connectorOperationIds(manifest).includes(invocation.action) ? invocation : undefined;
}

/** The one reading of a connector statement: its first line, where zero-width
 * characters before or right after the `@` (an escape Agents write so the text
 * does not summon) are invisible, and its offsets are into the body as written. */
function parseConnectorStatement(body: string, providerId?: string): { invocation: ConnectorInvocation; statement: ParsedConnectorActionCommand["statement"] } | undefined {
  const lineStart = body.search(/[^\s\u200B-\u200D\uFEFF]/u);
  if (lineStart < 0) return undefined;
  const newline = body.indexOf("\n", lineStart);
  const line = body.slice(lineStart, newline < 0 ? undefined : newline).trimEnd();
  const escape = /^[@＠]([\u200B-\u200D\uFEFF]*)/u.exec(line)?.[1]?.length ?? 0;
  const match = matchInteractionGrammar("connector.action.v1", line.slice(0, 1) + line.slice(1 + escape))[0];
  if (!match || (providerId !== undefined && match.arguments.provider!.toLowerCase() !== providerId.toLowerCase())) return undefined;
  const start = lineStart + match.start;
  // Parsing the whole body as Markdown is the expensive check; it runs only
  // once the first line reads as a command.
  if (!isOperationalMentionStart(start, nonOperationalMentionRanges(body))) return undefined;
  const { provider, action, target, text: argumentsText } = match.arguments;
  // Past the `@`, a match offset reads `escape` characters later in the body.
  const at = (offset: number) => lineStart + (offset > match.start ? offset + escape : offset);
  const end = at(match.end);
  const commandEnd = at(match.end - (argumentsText?.length ?? 0));
  const command = body.slice(start, commandEnd).trimEnd();
  const rest = newline < 0 ? [] : body.slice(newline + 1).trimEnd().split(/\r?\n/u);
  return { invocation: { start, end, text: body.slice(start, end), commandEnd: start + command.length,
    ...(target ? { target: { start: start + command.length - target.length, end: start + command.length } } : {}),
    provider: provider!.toLowerCase(), action: action!.toLowerCase() },
  statement: { target: target ?? "", text: [argumentsText?.trim() ?? "", ...rest].join("\n").trim() } };
}
