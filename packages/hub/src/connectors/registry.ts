import { connectorInteractionTarget, MessageInteractionRegistry, parseConnectorActionCommand } from "@xmatrix/protocol";
import { getAppConnectorProvider } from "../app-connectors";
import type { ConnectorProvider } from "./provider";
import { PLATFORM_CONNECTOR_PROVIDERS } from "./platform-providers";
import { githubConnectorProvider } from "./github";

/** Every provider the Hub runs; each id must have a shared manifest. */
const CONNECTOR_PROVIDERS: readonly ConnectorProvider[] = [githubConnectorProvider, ...PLATFORM_CONNECTOR_PROVIDERS];

/** The catalog is a projection of installed executors, not an authorization
 * store. Policy and credentials are rechecked by the selected executor. */
export function connectorInteractionRegistry(): MessageInteractionRegistry {
  return new MessageInteractionRegistry(CONNECTOR_PROVIDERS.filter(provider => provider.commands).map(provider => {
    const manifest = getAppConnectorProvider(provider.id);
    const operations = new Set([...(manifest?.actions.map(action => action.id) ?? []),
      ...(manifest?.events ? ["subscribe", "unsubscribe"] : []), "policy"]);
    return connectorInteractionTarget(provider.id, [...operations]);
  }));
}

/** The provider whose command a committed message starts with, if any. */
export function connectorForCommand(body: string): ConnectorProvider | undefined {
  const registry = connectorInteractionRegistry();
  for (const provider of CONNECTOR_PROVIDERS) {
    const parsed = parseConnectorActionCommand(provider.id, body);
    if (parsed && registry.resolve(provider.id, parsed.actionId).status === "resolved" && provider.commands?.accepts(body)) return provider;
  }
  return undefined;
}

export function connectorProvider(providerId: string): ConnectorProvider | undefined {
  const id = providerId.trim().toLowerCase();
  return CONNECTOR_PROVIDERS.find((provider) => provider.id === id);
}
