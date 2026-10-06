import { telegramChatId } from "@xmatrix/db";
import { timingSafeEqual } from "@xmatrix/protocol";
import { connectorEvent, excerpt, parseJsonObject, record, text } from "./event-format";
import { ProviderRequestError } from "./http";
import type { ConnectorEvent } from "./provider";
import { telegramSource } from "./telegram-native";

type Base = { chatSpace: string; eventTime: string; eventId: string };
type Interaction = Base & ({ kind: "link"; nonce: string; username: string; userId: number } |
  { kind: "removed" } | { kind: "message"; event: ConnectorEvent });
/** Telegram authenticates its HTTPS delivery with a configured secret header, not an HMAC. */
export function verifyTelegramAppRequest(secret: string, headers: Headers): void {
  if (!timingSafeEqual(headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) {
    throw new ProviderRequestError(401, "Invalid Telegram webhook authentication");
  }
}
function group(value: unknown): string | undefined {
  const chat = record(value);
  if (!["group", "supergroup"].includes(String(chat.type)) || !Number.isSafeInteger(chat.id)) return undefined;
  try { return telegramChatId(String(chat.id)); } catch { return undefined; }
}
function time(value: unknown, now: number): string | undefined {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return undefined;
  const at = Number(value) * 1000;
  return at >= now - 600_000 && at <= now + 30_000 ? new Date(at).toISOString() : undefined;
}
export function telegramAppInteraction(rawBody: string, botId: string, now = Date.now()): Interaction | undefined {
  const payload = parseJsonObject(rawBody);
  if (!payload || !Number.isSafeInteger(payload.update_id) || Number(payload.update_id) < 0) {
    throw new ProviderRequestError(400, "Invalid Telegram update");
  }
  const eventId = `telegram:bot:${botId}:update:${payload.update_id}`;
  if (payload.my_chat_member) {
    const update = record(payload.my_chat_member), chatSpace = group(update.chat), eventTime = time(update.date, now);
    const member = record(update.new_chat_member), user = record(member.user);
    if (!chatSpace || !eventTime || user.is_bot !== true || String(user.id) !== botId) return undefined;
    if (["left", "kicked"].includes(String(member.status)) || member.status === "restricted" &&
        (member.is_member !== true || member.can_send_messages !== true)) return { kind: "removed", chatSpace, eventTime, eventId };
    return undefined;
  }
  const message = record(payload.message), chatSpace = group(message.chat), eventTime = time(message.date, now);
  const from = record(message.from);
  if (!chatSpace || !eventTime) return undefined;
  if (message.migrate_to_chat_id !== undefined) {
    try { telegramChatId(String(message.migrate_to_chat_id)); } catch { return undefined; }
    return { kind: "removed", chatSpace, eventTime, eventId };
  }
  if (from.is_bot !== false || !Number.isSafeInteger(from.id) || Number(from.id) <= 0 || message.sender_chat ||
      !Number.isSafeInteger(message.message_id) || Number(message.message_id) <= 0 || typeof message.text !== "string") return undefined;
  const body = message.text;
  // Even malformed, copied or wrapped private challenges are never Channel messages or Automation content.
  if (/\/xmatrix_link(?:@[A-Za-z0-9_]+)?\b/iu.test(body)) {
    const link = /^\/xmatrix_link@([A-Za-z][A-Za-z0-9_]{4,31})\s+([A-Za-z0-9_-]{32})$/u.exec(body.trim());
    if (!link) return undefined;
    return { kind: "link", chatSpace, eventTime, eventId, username: link[1]!, nonce: link[2]!, userId: Number(from.id) };
  }
  if (!body.trim()) return undefined;
  const chat = record(message.chat);
  return { kind: "message", chatSpace, eventTime, eventId, event: connectorEvent({ eventId,
    sourceRef: telegramSource(chatSpace), feature: "messages", summary: `Telegram message in ${text(chat.title) || chatSpace}`,
    provider: "Telegram", title: `${text(from.username) || text(from.first_name) || "Someone"} in ${text(chat.title) || chatSpace}`,
    details: [excerpt(body, 1500)] }) };
}
