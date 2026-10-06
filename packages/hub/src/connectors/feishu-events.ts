import { sha256Hex, timingSafeEqual } from "@xmatrix/protocol";
import type { ConnectorDelivery, ConnectorDeliveryResult } from "./provider";
import { connectorEvent, excerpt, lowerHeader, parseJsonObject, record, sourceToken, text } from "./event-format";

/*
 * Feishu / Lark event subscriptions (schema 2.0). With an Encrypt Key the body
 * is `{ encrypt }` (AES-256-CBC, key = SHA-256 of the Encrypt Key, IV = first
 * 16 bytes) and `X-Lark-Signature` = SHA-256 of timestamp + nonce + key + body.
 * Either way the decrypted event's `token` must equal the Verification Token.
 * The URL-verification handshake is answered directly. A source is a chat id.
 */

export async function decryptFeishuPayload(encryptKey: string, ciphertext: string): Promise<string | undefined> {
  try {
    const bytes = Uint8Array.from(atob(ciphertext), (character) => character.charCodeAt(0));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptKey));
    const key = await crypto.subtle.importKey("raw", digest, { name: "AES-CBC" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: bytes.slice(0, 16) }, key, bytes.slice(16));
    return new TextDecoder().decode(plain);
  } catch {
    return undefined;
  }
}

function messageText(message: Record<string, unknown>): string {
  const content = parseJsonObject(text(message.content)) ?? {};
  return text(content.text) || text(content.title) || `[${text(message.message_type) || "message"}]`;
}

export async function receiveFeishuDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  const verificationToken = delivery.credentials.verificationToken;
  if (!verificationToken) return { ok: false, status: 401, error: "Feishu verification token is not configured" };
  let payload = parseJsonObject(delivery.rawBody);
  if (!payload) return { ok: false, status: 400, error: "Feishu body must be JSON" };
  if (typeof payload.encrypt === "string") {
    const encryptKey = delivery.credentials.encryptKey;
    if (!encryptKey) return { ok: false, status: 401, error: "Feishu encrypt key is not configured" };
    const signature = lowerHeader(delivery.headers, "x-lark-signature");
    if (signature) {
      const expected = await sha256Hex(`${lowerHeader(delivery.headers, "x-lark-request-timestamp")}` +
        `${lowerHeader(delivery.headers, "x-lark-request-nonce")}${encryptKey}${delivery.rawBody}`);
      if (!timingSafeEqual(signature.toLowerCase(), expected)) return { ok: false, status: 401, error: "Invalid Feishu signature" };
    }
    const decrypted = await decryptFeishuPayload(encryptKey, payload.encrypt);
    payload = decrypted ? parseJsonObject(decrypted) : undefined;
    if (!payload) return { ok: false, status: 400, error: "Feishu payload could not be decrypted" };
  }
  const header = record(payload.header);
  const token = text(header.token) || text(payload.token);
  if (!timingSafeEqual(token, verificationToken)) return { ok: false, status: 401, error: "Invalid Feishu verification token" };
  if (payload.type === "url_verification") {
    return { ok: "respond", response: Response.json({ challenge: text(payload.challenge) }) };
  }
  if (text(header.event_type) !== "im.message.receive_v1") return { ok: true, events: [] };
  const event = record(payload.event);
  const message = record(event.message);
  if (text(record(event.sender).sender_type) === "app") return { ok: true, events: [] };
  const chat = sourceToken(message.chat_id);
  return { ok: true, events: [connectorEvent({
    eventId: `feishu:${text(header.event_id) || text(message.message_id)}`,
    sourceRef: `feishu:${chat || "*"}`,
    feature: "messages",
    summary: `Feishu message in ${text(message.chat_id)}`,
    provider: "Feishu", title: `${text(record(record(event.sender).sender_id).open_id) || "Someone"} in ${text(message.chat_id)}`,
    details: [excerpt(messageText(message), 1_500)],
  })] };
}
