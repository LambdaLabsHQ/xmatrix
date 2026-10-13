/** Channel overrides are explicit; legacy deny remains a disallow alias. */
export type ConnectorActionPolicy = "allow" | "ask" | "disallow";

export function connectorActionPolicy(value: unknown): ConnectorActionPolicy | undefined {
  if (value === "deny") return "disallow";
  return value === "allow" || value === "ask" || value === "disallow" ? value : undefined;
}
