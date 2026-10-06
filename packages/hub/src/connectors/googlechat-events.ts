import { sha256Hex, utf8ByteLength } from "@xmatrix/protocol";
import { connectorEvent, excerpt, oneLine, record } from "./event-format";
import { ProviderRequestError } from "./http";
import type { ConnectorEvent } from "./provider";

const ROOM = /^spaces\/[A-Za-z0-9_-]{1,128}$/u;
/** Source projections are lowercase; hash opaque room bytes instead of folding their identity. */
export async function googleChatSource(chatSpace: string): Promise<string> {
  if (!ROOM.test(chatSpace)) throw new ProviderRequestError(400, "Invalid Google Chat space");
  return "googlechat:room-" + await sha256Hex(chatSpace);
}
type Interaction = { chatSpace: string; eventTime: string } & (
  { kind: "added" | "removed" | "invalid-link" } | { kind: "link"; nonce: string } |
  { kind: "message"; event: ConnectorEvent });

/** This normalizer is called only after the HTTP add-on's Google system identity verifies. */
export async function googleChatInteraction(payload: Record<string, unknown>): Promise<Interaction | null> {
  const chat = record(payload.chat);
  const triggers = Object.keys(chat).filter(key => key.endsWith("Payload"));
  if (triggers.length !== 1) throw new ProviderRequestError(400, "Ambiguous Google Chat interaction");
  const trigger = triggers[0]!;
  if (!["messagePayload", "addedToSpacePayload", "removedFromSpacePayload"].includes(trigger)) return null;
  const body = record(chat[trigger]), space = record(body.space), chatSpace = space.name;
  const eventTime = chat.eventTime;
  if (typeof chatSpace !== "string" || !ROOM.test(chatSpace) || typeof eventTime !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(eventTime) ||
      !Number.isFinite(Date.parse(eventTime)) || new Date(eventTime).toISOString().slice(0, 19) !== eventTime.slice(0, 19)) {
    throw new ProviderRequestError(400, "Invalid Google Chat interaction");
  }
  if (trigger === "removedFromSpacePayload") return { kind: "removed", chatSpace, eventTime };
  if (trigger === "addedToSpacePayload") return { kind: "added", chatSpace, eventTime };
  const message = record(body.message), user = record(chat.user), sender = record(message.sender);
  if (user.type !== "HUMAN" || sender.type !== "HUMAN" || user.name !== sender.name ||
      typeof user.name !== "string" || !/^users\/[A-Za-z0-9_-]{1,128}$/u.test(user.name) ||
      typeof message.name !== "string" || !message.name.startsWith(chatSpace + "/messages/") ||
      !/^[A-Za-z0-9_.-]{1,128}$/u.test(message.name.slice((chatSpace + "/messages/").length))) {
    throw new ProviderRequestError(400, "Google Chat did not confirm the interaction identity");
  }
  const messageText = typeof message.text === "string" ? message.text : "";
  const value = typeof message.argumentText === "string" ? message.argumentText.trim() : messageText.trim();
  // Never project a room-confirmation capability into xMatrix, including invalid/expired link attempts.
  if (/^link(?:\s|$)/iu.test(value)) {
    const nonce = value.match(/^link ([A-Za-z0-9_-]{32})$/u)?.[1];
    return nonce ? { kind: "link", nonce, chatSpace, eventTime } : { kind: "invalid-link", chatSpace, eventTime };
  }
  if (/\blink\s+[A-Za-z0-9_-]{32}/iu.test(messageText)) return { kind: "invalid-link", chatSpace, eventTime };
  if (!messageText.trim() || utf8ByteLength(messageText) > 4_000) {
    throw new ProviderRequestError(400, "Google Chat message exceeds its bound");
  }
  return { kind: "message", chatSpace, eventTime, event: connectorEvent({
    eventId: "googlechat:" + await sha256Hex(message.name + "|" + eventTime),
    sourceRef: await googleChatSource(chatSpace), feature: "messages",
    provider: "Google Chat", title: "Message", summary: "Google Chat: " + oneLine(messageText, 150),
    details: [excerpt(messageText, 600)],
  }) };
}

export function googleChatResponse(text: string): Response {
  return Response.json({ hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text } } } } });
}
