export interface MessagePublicationEvidence {
  entityVersion: number;
  bodyHash: string;
}

/** Only complete, unredacted publication evidence may identify a task source. */
export function messagePublicationEvidence(value: unknown): MessagePublicationEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.recalledAt || input.deletedAt || !Number.isSafeInteger(input.entityVersion) ||
      Number(input.entityVersion) < 1 || typeof input.bodyHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(input.bodyHash)) return undefined;
  return { entityVersion: Number(input.entityVersion), bodyHash: input.bodyHash };
}
