/** Attribution only: an OAuth client never replaces the human acting principal. */
export interface ExternalAppSource { clientId: string; name: string }

/** Names are self-declared by OAuth clients, not verified provider identities. */
export function externalAppSource(value: unknown): ExternalAppSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.clientId !== "string" || !source.clientId || source.clientId.length > 300 ||
    typeof source.name !== "string" || !source.name || source.name.length > 80) return undefined;
  return { clientId: source.clientId, name: source.name };
}

/** The reserved metadata key is written by Hub after it verifies the MCP caller. */
export function messageExternalAppSource(metadata: Record<string, unknown> | undefined): ExternalAppSource | undefined {
  return externalAppSource(metadata?.xmatrixMcpApplication);
}
