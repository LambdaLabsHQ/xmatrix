/**
 * An update to a committed message: its tombstone (recalled or deleted, body
 * empty) or its edit (new body and app metadata, `editedAt`). Updates never
 * carry work, notifications, attachments or a sender's client echo id.
 */
export type ChannelUpdateDelivery = {
  deliveryKind?: "update"; recalledAt?: string; deletedAt?: string; editedAt?: string; entityVersion?: number;
};

const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function parseChannelUpdateDelivery(input: Record<string, unknown>): ChannelUpdateDelivery | null {
  if (input.deliveryKind === undefined) return {};
  if (input.deliveryKind !== "update" || input.attachments !== undefined ||
      input.recipientNotifications !== undefined || input.clientMessageId !== undefined) return null;
  if (!Number.isSafeInteger(input.entityVersion) || Number(input.entityVersion) < 1) return null;
  const entityVersion = Number(input.entityVersion);
  const { recalledAt, deletedAt, editedAt } = input;
  if (recalledAt === undefined && deletedAt === undefined) {
    return instant(editedAt) && typeof input.body === "string"
      ? { deliveryKind: "update", entityVersion, editedAt } : null;
  }
  if (input.body !== "" || input.metadata !== undefined || editedAt !== undefined ||
      (recalledAt === undefined) === (deletedAt === undefined)) return null;
  const at = recalledAt ?? deletedAt;
  if (!instant(at)) return null;
  return { deliveryKind: "update", entityVersion, ...(recalledAt === undefined ? { deletedAt: at } : { recalledAt: at }) };
}
