import { getAppConnectorProvider } from "../app-connectors";
import type { ConnectorAction } from "./provider";

/**
 * The executable vocabulary shared by Channel commands and MCP. A manifest
 * declaration needs an own executor with the same effect; object prototypes
 * and undeclared implementations never become actions. This is admission,
 * not authorization: execution still checks Channel access and live policy.
 */
export function connectorActionCatalog(providerId: string, actions: Readonly<Record<string, ConnectorAction>> = {}) {
  const declared = getAppConnectorProvider(providerId)?.actions ?? [];
  return new Map(declared.flatMap(definition => {
    if (!definition.effect || !Object.hasOwn(actions, definition.id)) return [];
    const executor = actions[definition.id];
    return executor?.effect === definition.effect ? [[definition.id, { definition, executor }] as const] : [];
  }));
}
