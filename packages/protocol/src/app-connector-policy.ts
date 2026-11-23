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

/**
 * The X actions a durable executor runs after their request is consumed: an
 * upload, and an upload followed by its post. Both outlast one HTTP request,
 * and neither is ever sent twice.
 */
export const X_DURABLE_ACTIONS = ["upload_video", "publish_video"] as const;
export const isXDurableAction = (providerId: string, actionId: string): boolean =>
  providerId === "x" && (X_DURABLE_ACTIONS as readonly string[]).includes(actionId);
