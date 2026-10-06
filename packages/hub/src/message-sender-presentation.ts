type ProductMessageAuthorKind = "user" | "agent" | "app" | "system";

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Canonical sender snapshots preserve their exact historical wire shape.
 * Product history additionally needs the stable MessageSender presentation
 * fields consumed by existing Web, Desktop, and CLI clients.
 */
export function productMessageSenderPresentation(
  snapshot: Record<string, unknown>,
  authorKind: string,
  authorId: string,
): Record<string, unknown> {
  if (authorKind !== "user" && authorKind !== "agent" && authorKind !== "app" && authorKind !== "system") {
    throw new TypeError("product message author kind is unsupported");
  }
  const kind: ProductMessageAuthorKind = authorKind;
  const prefix = `${kind}:`;
  const identityId = authorId.startsWith(prefix) ? authorId : `${prefix}${authorId}`;
  const label = (
    kind === "agent"
      ? [snapshot.label, snapshot.agentName, snapshot.name]
      : [snapshot.label, snapshot.name]
  ).map(nonEmptyText).find((value) => value !== undefined) ?? `Unknown ${kind}`;
  const userId = nonEmptyText(snapshot.userId) ??
    (kind === "user" ? identityId.slice("user:".length) : "");
  const email = typeof snapshot.email === "string" ? snapshot.email : "";
  return {
    ...snapshot,
    identityId,
    kind,
    label,
    userId,
    email,
    ...(kind === "agent"
      ? { agentName: nonEmptyText(snapshot.agentName) ?? label }
      : {}),
  };
}
