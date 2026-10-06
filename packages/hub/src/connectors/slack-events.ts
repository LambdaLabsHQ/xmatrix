import type { ConnectorDelivery, ConnectorDeliveryResult } from "./provider";
import { hmacHex, timingSafeEqual } from "@xmatrix/protocol";
import { connectorEvent, excerpt, lowerHeader, parseJsonObject, record, sourceToken, text } from "./event-format";

/*
 * Slack Events API: `X-Slack-Signature` is `v0=` + HMAC-SHA256 of
 * `v0:<timestamp>:<body>` with the app's signing secret, and a timestamp more
 * than five minutes off is refused as a replay. The URL-verification handshake
 * is answered directly. Bot messages are dropped so the Hub's own posts back
 * into Slack never loop. A source is a Slack channel id.
 */

const MAX_SKEW_SECONDS = 300;

export async function receiveSlackDelivery(delivery: ConnectorDelivery,
  now: number = Date.now()): Promise<ConnectorDeliveryResult> {
  const timestamp = lowerHeader(delivery.headers, "x-slack-request-timestamp");
  const seconds = Number(timestamp);
  const secret = delivery.credentials.signingSecret;
  if (!secret || !Number.isFinite(seconds) || Math.abs(now / 1_000 - seconds) > MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, error: "Invalid Slack request timestamp" };
  }
  const expected = `v0=${await hmacHex("SHA-256", secret, `v0:${timestamp}:${delivery.rawBody}`)}`;
  if (!timingSafeEqual(lowerHeader(delivery.headers, "x-slack-signature").toLowerCase(), expected)) {
    return { ok: false, status: 401, error: "Invalid Slack signature" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return { ok: false, status: 400, error: "Slack body must be JSON" };
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
}
