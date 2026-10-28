/** Internal action admission result derived from the app permission. */
export type ConnectorActionPolicy = "allow" | "ask" | "disallow";

export function connectorActionPolicy(value: unknown): ConnectorActionPolicy | undefined {
  if (value === "deny") return "disallow";
  return value === "allow" || value === "ask" || value === "disallow" ? value : undefined;
}

/** The connection's single permission; reads are available in every mode. */
export type ConnectorPermission = "read" | "ask" | "write";
export function connectorPermission(value: unknown): ConnectorPermission | undefined {
  return value === "read" || value === "ask" || value === "write" ? value : undefined;
}
