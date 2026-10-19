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
  const normalized = body.trim().replace(/^[\u200B-\u200D\uFEFF]*/u, "")
    .replace(/^([@＠])[\u200B-\u200D\uFEFF]*/u, "$1");
  const [first = "", ...rest] = normalized.split(/\r?\n/u);
  const parsed = matchInteractionGrammar("connector.action.v1", first.trim())[0];
  if (!parsed || parsed.arguments.provider!.toLowerCase() !== providerId.toLowerCase()) return undefined;
  // Parsing the whole body as Markdown is the expensive check; it runs only
  // once the first line reads as this provider's command.
  if (!isOperationalMentionStart(body.search(/\S/u), nonOperationalMentionRanges(body))) return undefined;
  return { actionId: parsed.arguments.action!.toLowerCase(), statement: {
    target: parsed.arguments.target ?? "", text: [parsed.arguments.text?.trim() ?? "", ...rest].join("\n").trim() } };
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
 * connector the protocol knows. */
export function parseConnectorInvocation(body: string): ConnectorInvocation | undefined {
  const lineStart = body.search(/[^\s\u200B-\u200D\uFEFF]/u);
  if (lineStart < 0) return undefined;
  const newline = body.indexOf("\n", lineStart);
  const line = body.slice(lineStart, newline < 0 ? undefined : newline);
  const match = matchInteractionGrammar("connector.action.v1", line)[0];
  if (!match) return undefined;
  const { provider: writtenProvider, action: writtenAction, target, text: statement } = match.arguments;
  const provider = writtenProvider!.toLowerCase();
  const action = writtenAction!.toLowerCase();
  const manifest = APP_CONNECTOR_PROVIDER_MANIFESTS.find(candidate => candidate.id === provider);
  if (!manifest || !connectorOperationIds(manifest).includes(action)) return undefined;
  const start = lineStart + match.start;
  if (!isOperationalMentionStart(start, nonOperationalMentionRanges(body))) return undefined;
  const written = line.slice(match.start, match.end).trimEnd();
  const command = line.slice(match.start, match.end - (statement?.length ?? 0)).trimEnd();
  const commandEnd = start + command.length;
  return { start, end: start + written.length, text: written, commandEnd,
    ...(target ? { target: { start: commandEnd - target.length, end: commandEnd } } : {}), provider, action };
}
