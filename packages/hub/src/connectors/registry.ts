import { connectorInteractionTarget, connectorOperationIds, MessageInteractionRegistry, parseConnectorActionCommand } from "@xmatrix/protocol";
import { getAppConnectorProvider } from "../app-connectors";
import type { ConnectorProvider } from "./provider";
import { PLATFORM_CONNECTOR_PROVIDERS } from "./platform-providers";
import { githubConnectorProvider } from "./github";
import { checkAppConnection } from "../app-connection-check";
import { connectorActionCatalog } from "./action-catalog";
import { installActionExecutors, installAppConnectionCheck } from "./connector-commands";

/** Every provider the Hub runs; each id must have a shared manifest. */
const CONNECTOR_PROVIDERS: readonly ConnectorProvider[] = [githubConnectorProvider, ...PLATFORM_CONNECTOR_PROVIDERS];
// Commands re-check a failed app connection through the registry's own providers.
installAppConnectionCheck((env, check) => checkAppConnection(env, check));
// An action a Norn program performs runs with its provider's own executor, found among the registry's providers.
installActionExecutors((providerId, actionId) => {
  const provider = connectorProvider(providerId);
  return provider ? connectorActionCatalog(provider.id, provider.actions).get(actionId)?.executor : undefined;
});

/** The catalog is a projection of installed executors, not an authorization
 * store. Policy and credentials are rechecked by the selected executor. */
export function connectorInteractionRegistry(): MessageInteractionRegistry {
  return new MessageInteractionRegistry(CONNECTOR_PROVIDERS.filter(provider => provider.commands).map(provider => {
    // Project the complete executor-backed catalog; overflow must never hide actions.
    return connectorInteractionTarget(provider.id, connectorOperationIds(getAppConnectorProvider(provider.id)));
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
