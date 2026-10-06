import type { AppConnectorProviderManifest } from "@xmatrix/protocol";
import { appCommand, listAppSourceRelations } from "../apps";
import { commandScope, record, withExecution } from "./command-support";
import { connectionCredentials } from "./connection-credentials";
import { connectorAppRepository } from "./credentials";
import { ProviderRequestError } from "./http";
import type { ConnectorCommandInput, ConnectorSubscriptionSync } from "./provider";
import { nextSubscriptionFeatures, parseConnectorSubscription } from "./subscription-parse";

/*
 * Runs `@<provider>:subscribe|unsubscribe:<source>` for an event provider
 * (docs/design/connector-platform.md §3.3). The subscription is the Channel's
 * source relation for the connection and source — the same provider-neutral
 * relation GitHub repository subscriptions use (stored with the
 * collection-level `repository` source kind). A provider that keeps its own
 * configuration for a source (Cloudflare's notification policies) is synced
 * before a subscribe is recorded and after the Space's last unsubscribe.
 */
export async function runSubscriptionStatement(
  manifest: AppConnectorProviderManifest,
  input: ConnectorCommandInput,
  line: string,
  statementKey: string,
  subscriptions?: ConnectorSubscriptionSync,
): Promise<string> {
  const statement = parseConnectorSubscription(manifest, line);
  if (!statement) return `${manifest.name}: ignored.`;
  const label = `${manifest.name} ${statement.action}`;
  if (!statement.ok) return `${label}: failed; ${statement.reason.replace(/_/gu, " ")}.`;
  const scope = await commandScope(manifest, input);
  if (typeof scope === "string") return `${label}: blocked; ${scope}.`;
  return withExecution(manifest, input, scope, { id: statement.action, key: statementKey,
    label: statement.action === "subscribe" ? "Subscribe source" : "Unsubscribe source" }, async () => {
    const relations = await listAppSourceRelations(input.env, { channelId: input.channelId, principal: scope.principal });
    const current = relations.map(record).find((candidate) => candidate.connectionId === scope.connectionId &&
      candidate.kind === "repository" && candidate.source === statement.sourceRef);
    const currentFeatures = Array.isArray(current?.features) ? current.features.map(String) : [];
    const next = nextSubscriptionFeatures(manifest, currentFeatures, statement);
    const sync = subscriptions && (async (subscribed: boolean) => subscriptions.sync({ env: input.env,
      spaceId: scope.spaceId, credentials: await connectionCredentials(input.env, scope.spaceId, manifest.id),
      source: statement.source, subscribed }).catch((error: unknown) => {
      if (error instanceof ProviderRequestError) return `${manifest.name} refused the change: ${error.message}`;
      throw error;
    }));
    if (sync && next.length > 0) {
      const refused = await sync(true);
      if (refused) return { status: "failed", summary: refused };
    }
    if (next.length > 0) {
      await appCommand(input.env, "put-relation", {
        commandId: `product:${manifest.id}-relation:${input.messageId}${statementKey}:put`.slice(0, 200),
        connectionId: scope.connectionId, channelId: input.channelId, sourceKind: "repository",
        sourceRef: statement.sourceRef, features: next, principal: scope.principal,
      });
    } else if (typeof current?.id === "string") {
      await appCommand(input.env, "remove-relation", {
        commandId: `product:${manifest.id}-relation:${input.messageId}${statementKey}:remove`.slice(0, 200),
        relationId: current.id, principal: scope.principal,
      });
      const remaining = sync && await connectorAppRepository(input.env).connectorEventRoutes({
        requestId: crypto.randomUUID(), connectionId: scope.connectionId, sourceRef: statement.sourceRef, limit: 1 });
      const unsynced = sync && remaining?.length === 0 ? await sync(false) : undefined;
      if (unsynced) return { status: "failed", summary: `Unsubscribed from ${statement.source}, but ${unsynced}` };
    }
    return { status: "completed", summary: next.length > 0
      ? `${statement.action === "subscribe" ? "Subscribed to" : "Updated"} ${statement.source} (${next.join(", ")})`
      : `Unsubscribed from ${statement.source}` };
  });
}
