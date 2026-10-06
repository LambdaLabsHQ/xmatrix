/** Never expose a Machine command's execution key, lease or private payload. */
export function safeReplyRecoveryResult(raw: unknown) {
  const unavailable = { status: "unavailable" as const, code: "reply_recovery_failed" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unavailable;
  const value = raw as Record<string, unknown>;
  const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
  if (value.status === "committed" && id(value.messageId)) return { status: "committed" as const, messageId: value.messageId };
  if (value.status === "selection_required" && Array.isArray(value.candidates) && value.candidates.length <= 20) {
    const candidates = value.candidates.flatMap(item => item && typeof item === "object" && id(item.messageId) &&
      Number.isSafeInteger(item.createdAt) && item.createdAt >= 0 && item.createdAt <= 8_640_000_000_000
      ? [{ messageId: item.messageId as string, createdAt: item.createdAt as number }] : []);
    if (candidates.length === value.candidates.length && candidates.length > 1) return { status: "selection_required" as const, candidates };
  }
  if (value.status === "unavailable" && ["saved_reply_unavailable", "recovery_broker_unavailable"].includes(String(value.code))) {
    return { status: "unavailable" as const, code: String(value.code) };
  }
  return unavailable;
}
