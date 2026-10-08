import { createSignedJsonReceiver } from "./delivery-proof";
import { connectorEvent, excerpt, lowerHeader, record, sourceToken, text } from "./event-format";

/*
 * Slack Events API: `X-Slack-Signature` is `v0=` + HMAC-SHA256 of
 * `v0:<timestamp>:<body>` with the app's signing secret, and a timestamp more
 * than five minutes off is refused as a replay. The URL-verification handshake
 * is answered directly. Bot messages are dropped so the Hub's own posts back
 * into Slack never loop. A source is a Slack channel id.
 */

export const receiveSlackDelivery = createSignedJsonReceiver({
  name: "Slack", secretField: "signingSecret", proof: {
    header: "x-slack-signature", prefix: "v0=",
    timestamp: (headers) => lowerHeader(headers, "x-slack-request-timestamp"),
    signed: (body, timestamp) => `v0:${timestamp}:${body}`,
  },
}, (_, payload) => {
  if (payload.type === "url_verification") {
    return { ok: "respond", response: Response.json({ challenge: text(payload.challenge) }) };
  }
  if (payload.type !== "event_callback") return { ok: true, events: [] };
  const event = record(payload.event);
  const eventId = `slack:${text(payload.event_id) || `${text(event.channel)}:${text(event.ts)}`}`;
  if (event.type === "message") {
    if (event.bot_id || event.subtype) return { ok: true, events: [] };
    const channel = sourceToken(event.channel);
    return { ok: true, events: [connectorEvent({ eventId, sourceRef: `slack:${channel || "*"}`, feature: "messages",
      summary: `Slack message in ${text(event.channel)}`,
      provider: "Slack", title: `${text(event.user)} in #${text(event.channel)}${event.thread_ts ? " (thread)" : ""}`,
      details: [excerpt(event.text, 1_500)] })] };
  }
  if (event.type === "reaction_added") {
    const item = record(event.item);
    return { ok: true, events: [connectorEvent({ eventId, sourceRef: `slack:${sourceToken(item.channel) || "*"}`, feature: "reactions",
      summary: `:${text(event.reaction)}: in ${text(item.channel)}`,
      provider: "Slack", title: `${text(event.user)} reacted :${text(event.reaction)}: in #${text(item.channel)}` })] };
  }
  return { ok: true, events: [] };
});
