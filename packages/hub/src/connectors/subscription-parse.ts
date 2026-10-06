import { parseConnectorActionCommand, type AppConnectorProviderManifest } from "@xmatrix/protocol";

/*
 * `@<provider>:subscribe:<source> [feature…|all]` and its `unsubscribe` twin
 * for every provider that declares `events` (docs/design/connector-platform.md
 * §3.3). GitHub keeps its own parser for issue and pull request refs.
 */

export const SUBSCRIPTION_STATEMENT_LIMIT = 8;

export type ConnectorSubscriptionStatement =
  | { ok: true; action: "subscribe" | "unsubscribe"; source: string; sourceRef: string; features: string[] }
  | { ok: false; action: "subscribe" | "unsubscribe"; reason: string };

/** Whether a message's first line is a subscription command for this provider. */
export function isConnectorSubscriptionCommand(providerId: string, body: string): boolean {
  const parsed = parseConnectorActionCommand(providerId, body);
  return parsed?.actionId === "subscribe" || parsed?.actionId === "unsubscribe";
}

export function parseConnectorSubscription(
  manifest: AppConnectorProviderManifest,
  line: string,
): ConnectorSubscriptionStatement | undefined {
  const parsed = parseConnectorActionCommand(manifest.id, line);
  if (!parsed || !manifest.events || (parsed.actionId !== "subscribe" && parsed.actionId !== "unsubscribe")) return undefined;
  const action = parsed.actionId;
  const source = parsed.statement.target.trim().toLowerCase();
  /* `*` subscribes every source the connection delivers. */
  if (!source || (source !== "*" && !new RegExp(manifest.events.source.pattern, "u").test(source))) {
    return { ok: false, action, reason: `missing_or_invalid_${manifest.events.source.label.toLowerCase().replace(/\s+/gu, "_")}` };
  }
  const known = manifest.events.features.map((feature) => feature.id);
  const named = parsed.statement.text.split(/[\s,]+/u).map((token) => token.trim().toLowerCase()).filter(Boolean);
  const unknown = named.filter((token) => token !== "all" && !known.includes(token));
  if (unknown.length > 0) return { ok: false, action, reason: `unknown_features:${unknown.slice(0, 8).join(",")}` };
  const features = named.includes("all")
    ? known
    : named.length > 0 ? known.filter((feature) => named.includes(feature)) : action === "unsubscribe" ? known
      : manifest.events.defaultFeatures;
  return { ok: true, action, source, sourceRef: `${manifest.id}:${source}`, features };
}

/** One message's statements: every line that is a subscription command, bounded. */
export function connectorSubscriptionStatements(manifest: AppConnectorProviderManifest, body: string): string[] {
  const lines = body.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!lines[0] || !parseConnectorSubscription(manifest, lines[0])) return [];
  return lines.filter((line) => parseConnectorSubscription(manifest, line) !== undefined)
    .slice(0, SUBSCRIPTION_STATEMENT_LIMIT);
}

/** The feature set after a statement: subscribe adds, unsubscribe subtracts. */
export function nextSubscriptionFeatures(
  manifest: AppConnectorProviderManifest,
  current: readonly string[],
  statement: Extract<ConnectorSubscriptionStatement, { ok: true }>,
): string[] {
  const known = manifest.events?.features.map((feature) => feature.id) ?? [];
  const set = new Set(current);
  for (const feature of statement.features) {
    if (statement.action === "subscribe") set.add(feature);
    else set.delete(feature);
  }
  return known.filter((feature) => set.has(feature));
}
