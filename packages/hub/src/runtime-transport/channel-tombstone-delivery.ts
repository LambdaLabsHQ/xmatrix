/** Updates carry only a committed tombstone, never work, notifications or stale payload fields. */
export function parseChannelTombstoneDelivery(input: Record<string, unknown>): {
  deliveryKind?: "update"; recalledAt?: string; deletedAt?: string; entityVersion?: number;
} | null {
  if (input.deliveryKind === undefined) return {};
  if (input.deliveryKind !== "update" || input.body !== "" ||
      input.attachments !== undefined || input.metadata !== undefined ||
      input.recipientNotifications !== undefined || input.clientMessageId !== undefined) return null;
  if (!Number.isSafeInteger(input.entityVersion) || Number(input.entityVersion) < 1) return null;
  const recalledAt = input.recalledAt;
  const deletedAt = input.deletedAt;
  if ((recalledAt === undefined) === (deletedAt === undefined)) return null;
  const at = recalledAt ?? deletedAt;
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
  return { deliveryKind: "update", entityVersion: Number(input.entityVersion), ...(recalledAt === undefined ? { deletedAt: at } : { recalledAt: at }) };
}
