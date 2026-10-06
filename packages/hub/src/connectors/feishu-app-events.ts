import { sha256Hex, timingSafeEqual, utf8ByteLength } from "@xmatrix/protocol";
import { decryptFeishuPayload } from "./feishu-events";
import { connectorEvent, excerpt, oneLine, parseJsonObject, record } from "./event-format";
import { FEISHU_CHAT, FEISHU_TENANT, feishuRoom, feishuSource, type feishuNativeApp } from "./feishu-native";
import { ProviderRequestError } from "./http";
import type { ConnectorEvent } from "./provider";

type Native = NonNullable<Awaited<ReturnType<typeof feishuNativeApp>>>;
type Interaction = { eventId: string; eventTime: string } & (
  { kind: "ticket"; ticket: string } | { kind: "tenant"; tenantKey: string; active: boolean } |
  { kind: "removed" | "invalid-link"; chatSpace: string } | { kind: "link"; chatSpace: string; nonce: string } |
  { kind: "message"; chatSpace: string; event: ConnectorEvent });
const failure = () => new ProviderRequestError(401, "Feishu request authentication failed");

/** URL verification changes no authority; every other company event requires encrypted signed bytes. */
export async function verifyFeishuAppRequest(native: Native, rawBody: string, headers: Headers, now = Date.now()): Promise<Record<string, unknown>> {
  if (utf8ByteLength(rawBody) > 32 * 1024) throw new ProviderRequestError(413, "Feishu event exceeds its bound");
  let payload = parseJsonObject(rawBody);
  if (!payload) throw new ProviderRequestError(400, "Invalid Feishu event");
  const encrypted = typeof payload.encrypt === "string";
  if (encrypted) {
    if (Object.keys(payload).some(key => key !== "encrypt") || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload.encrypt as string)) throw failure();
    const plaintext = await decryptFeishuPayload(native.encryptKey, payload.encrypt as string);
    payload = plaintext ? parseJsonObject(plaintext) : undefined;
    if (!payload) throw failure();
  }
  const header = record(payload.header);
  const token = payload.schema === "2.0" ? header.token : payload.token;
  if (typeof token !== "string" || !timingSafeEqual(token, native.verificationToken)) throw failure();
  if (payload.type === "url_verification") {
    if (typeof payload.challenge !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(payload.challenge)) throw failure();
    return payload;
  }
  const timestamp = headers.get("x-lark-request-timestamp") ?? "", nonce = headers.get("x-lark-request-nonce") ?? "";
  const signature = headers.get("x-lark-signature") ?? "";
  if (!encrypted || !/^[1-9][0-9]{9}$/u.test(timestamp) || !/^[A-Za-z0-9_-]{1,128}$/u.test(nonce) ||
      !/^[a-fA-F0-9]{64}$/u.test(signature) || Number(timestamp) * 1000 < now - 300_000 || Number(timestamp) * 1000 > now + 30_000) throw failure();
  const expected = await sha256Hex(timestamp + nonce + native.encryptKey + rawBody);
  if (!timingSafeEqual(signature.toLowerCase(), expected)) throw failure();
  const event = record(payload.event);
  if ((payload.schema === "2.0" ? header.app_id : event.app_id) !== native.app.appId) throw failure();
  return payload;
}
/** Schema 1 lifecycle and schema 2 chat events are normalized only after the exact app verifies. */
export async function feishuAppInteraction(payload: Record<string, unknown>, now = Date.now()): Promise<Interaction | null> {
  const header = record(payload.header), event = record(payload.event), v2 = payload.schema === "2.0";
  if (!v2 && payload.type !== "event_callback") throw new ProviderRequestError(400, "Invalid Feishu event envelope");
  const type = v2 ? header.event_type : event.type;
  const id = v2 ? header.event_id : payload.uuid, time = v2 ? header.create_time : payload.ts;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(id) || typeof time !== "string" ||
      !(v2 ? /^[1-9][0-9]{12}$/u : /^[1-9][0-9]{9}(?:\.[0-9]{1,6})?$/u).test(time)) {
    throw new ProviderRequestError(400, "Feishu did not confirm the event identity and time");
  }
  const milliseconds = Number(time) * (v2 ? 1 : 1000);
  if (!Number.isFinite(milliseconds) || milliseconds < now - 600_000 || milliseconds > now + 30_000) throw new ProviderRequestError(400, "Feishu event expired");
  const base = { eventId: id, eventTime: new Date(milliseconds).toISOString() };
  if (!v2 && type === "app_ticket") {
    if (typeof event.app_ticket !== "string" || !event.app_ticket.trim() || event.app_ticket.length > 4096) throw new ProviderRequestError(400, "Invalid Feishu ticket");
    return { ...base, kind: "ticket", ticket: event.app_ticket };
  }
  const tenantKey = v2 ? header.tenant_key : event.tenant_key;
  if (typeof tenantKey !== "string" || !FEISHU_TENANT.test(tenantKey)) throw new ProviderRequestError(400, "Invalid Feishu tenant");
  if (!v2 && ["app_open", "app_status_change", "app_uninstalled"].includes(String(type))) {
    if (type === "app_status_change" && !["start_by_tenant", "stop_by_tenant", "stop_by_platform"].includes(String(event.status))) {
      throw new ProviderRequestError(400, "Invalid Feishu application lifecycle");
    }
    return { ...base, kind: "tenant", tenantKey, active: type === "app_open" || type === "app_status_change" && event.status === "start_by_tenant" };
  }
  if (!v2 || !["im.message.receive_v1", "im.chat.member.bot.deleted_v1"].includes(String(type))) return null;
  if (type === "im.chat.member.bot.deleted_v1") {
    if (typeof event.chat_id !== "string" || !FEISHU_CHAT.test(event.chat_id)) throw new ProviderRequestError(400, "Invalid Feishu group removal");
    return { ...base, kind: "removed", chatSpace: feishuRoom(tenantKey, event.chat_id) };
  }
  const message = record(event.message), sender = record(event.sender);
  if (sender.sender_type === "app" || message.chat_type !== "group") return null;
  if (sender.sender_type !== "user" || typeof record(sender.sender_id).open_id !== "string" ||
      !/^ou_[A-Za-z0-9]{4,128}$/u.test(String(record(sender.sender_id).open_id)) ||
      typeof message.chat_id !== "string" || !FEISHU_CHAT.test(message.chat_id) ||
      typeof message.message_id !== "string" || !/^om_[A-Za-z0-9]{4,128}$/u.test(message.message_id)) {
    throw new ProviderRequestError(400, "Feishu did not confirm the group message identity");
  }
  const chatSpace = feishuRoom(tenantKey, message.chat_id);
  const content = parseJsonObject(typeof message.content === "string" ? message.content : "");
  if (message.message_type !== "text" || typeof content?.text !== "string") return null;
  const text = content.text;
  if (!text.trim() || utf8ByteLength(text) > 4000) throw new ProviderRequestError(400, "Feishu message exceeds its bound");
  // Suppress capabilities even when copied into an invalid command; never project a nonce into Channels/Automation.
  if (/\blink(?:\s|$)/iu.test(text) && /(?:@xMatrix|@_user_[0-9]+|[A-Za-z0-9_-]{32})/iu.test(text)) {
    const value = text.replace(/^@_user_[0-9]+\s*/u, "@xMatrix ").trim();
    const nonce = value.match(/^@xMatrix link ([A-Za-z0-9_-]{32})$/u)?.[1];
    return nonce ? { ...base, kind: "link", chatSpace, nonce } : { ...base, kind: "invalid-link", chatSpace };
  }
  return { ...base, kind: "message", chatSpace, event: connectorEvent({
    eventId: "feishu:" + await sha256Hex(tenantKey + "|" + message.message_id), sourceRef: await feishuSource(chatSpace),
    feature: "messages", provider: "Feishu", title: "Message", summary: "Feishu: " + oneLine(text, 150), details: [excerpt(text, 600)],
  }) };
}
