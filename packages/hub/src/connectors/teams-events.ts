import { sha256Hex, utf8ByteLength } from "@xmatrix/protocol";
import { teamsReference, teamsRoomId, type TeamsAppIdentity, type TeamsConversationReference } from "@xmatrix/db";
import { connectorEvent, excerpt, oneLine, record } from "./event-format";
import { ProviderRequestError } from "./http";
import type { ConnectorEvent } from "./provider";

export function teamsSource(chatSpace: string): string {
  if (!/^room-[a-f0-9]{64}$/u.test(chatSpace)) throw new ProviderRequestError(400, "Invalid Teams conversation source");
  return `teams:${chatSpace}`;
}
type Interaction = { chatSpace: string; eventTime: string } & (
  { kind: "removed" | "ignored" } | { kind: "member-removed"; users: string[] } | { kind: "link"; nonce: string; reference: TeamsConversationReference } |
  { kind: "message"; reference: TeamsConversationReference; event: ConnectorEvent });

/** Call only after Microsoft Connector JWT authentication, including the service URL claim. */
export async function teamsInteraction(payload: Record<string, unknown>, app: TeamsAppIdentity): Promise<Interaction> {
  const conversation = record(payload.conversation), data = record(payload.channelData), from = record(payload.from);
  const recipient = record(payload.recipient), tenant = record(data.tenant);
  const eventTime = payload.timestamp;
  if (payload.channelId !== "msteams" || recipient.id !== `28:${app.appId}` || tenant.id !== app.tenantId ||
      (conversation.tenantId !== undefined && conversation.tenantId !== tenant.id) ||
      !["personal", "groupChat"].includes(String(conversation.conversationType)) || data.team !== undefined || data.channel !== undefined || data.meeting !== undefined ||
      typeof conversation.id !== "string" || !/^[A-Za-z0-9_:;@.+=/-]{1,512}$/u.test(conversation.id) ||
      typeof eventTime !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(eventTime) ||
      !Number.isFinite(Date.parse(eventTime)) || new Date(eventTime).toISOString().slice(0, 19) !== eventTime.slice(0, 19) ||
      Date.parse(eventTime) < Date.now() - 600_000 || Date.parse(eventTime) > Date.now() + 30_000) {
    throw new ProviderRequestError(400, "Teams conversation identity or time was not confirmed");
  }
  const chatSpace = await teamsRoomId({ tenantId: app.tenantId, conversationId: conversation.id } as TeamsConversationReference);
  const base = { chatSpace, eventTime };
  const removed = payload.type === "installationUpdate" && ["remove", "remove-upgrade"].includes(String(payload.action)) ||
    payload.type === "conversationUpdate" && Array.isArray(payload.membersRemoved) &&
      payload.membersRemoved.some(member => record(member).id === recipient.id);
  if (removed) return { ...base, kind: "removed" };
  if (payload.type === "conversationUpdate" && Array.isArray(payload.membersRemoved)) {
    if (payload.membersRemoved.length > 20) throw new ProviderRequestError(413, "Teams membership update exceeds its bound");
    const users = payload.membersRemoved.map(member => record(member).id).filter((id): id is string =>
      typeof id === "string" && /^29:[A-Za-z0-9_:;@.+=/-]{1,509}$/u.test(id));
    return { ...base, kind: "member-removed", users };
  }
  if (payload.type !== "message") return { ...base, kind: "ignored" };
  let reference: TeamsConversationReference;
  try { reference = teamsReference({ tenantId: app.tenantId, conversationId: conversation.id,
    conversationType: conversation.conversationType as "personal" | "groupChat", serviceUrl: payload.serviceUrl as string,
    userId: from.id as string, userObjectId: from.aadObjectId as string }, app); }
  catch { throw new ProviderRequestError(400, "Teams user identity was not confirmed"); }
  if (typeof payload.id !== "string" || !/^[A-Za-z0-9_:.-]{1,256}$/u.test(payload.id) ||
      typeof payload.text !== "string" || !payload.text.trim() || utf8ByteLength(payload.text) > 4_000 ||
      payload.textFormat !== undefined && !["plain", "xml", "markdown"].includes(String(payload.textFormat))) {
    throw new ProviderRequestError(400, "Teams message exceeds its bound");
  }
  // Strip only the verified bot mention. Other HTML and mentions stay untrusted text.
  let value = payload.text.trim();
  if (value.startsWith("<at>")) {
    const mention = value.match(/^<at>[^<]{1,100}<\/at>\s*/u)?.[0];
    const entities = Array.isArray(payload.entities) ? payload.entities : [];
    if (mention && entities.some(entity => record(entity).type === "mention" &&
        record(record(entity).mentioned).id === recipient.id && record(entity).text === mention.trim())) value = value.slice(mention.length).trim();
  }
  if (/^link(?:\s|$)/iu.test(value)) {
    const nonce = value.match(/^link ([A-Za-z0-9_-]{32})$/u)?.[1];
    return nonce ? { ...base, kind: "link", nonce, reference } : { ...base, kind: "ignored" };
  }
  // Confirmation capabilities never cross into Channel messages, diagnostics or Automations.
  if (/\blink\s+[A-Za-z0-9_-]{32}/iu.test(payload.text)) return { ...base, kind: "ignored" };
  return { ...base, kind: "message", reference, event: connectorEvent({
    eventId: "teams:" + await sha256Hex(JSON.stringify([app.appId, app.tenantId, conversation.id, payload.id])),
    sourceRef: teamsSource(chatSpace), feature: "messages", provider: "Microsoft Teams", title: "Message",
    summary: "Teams: " + oneLine(value, 150), details: [excerpt(value, 600)],
  }) };
}
