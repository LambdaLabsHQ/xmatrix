import type { ConnectorDelivery, ConnectorDeliveryResult } from "./provider";
import { timingSafeEqual } from "@xmatrix/protocol";
import { connectorEvent, excerpt, lowerHeader, oneLine, parseJsonObject, record, sourceToken, text } from "./event-format";

/*
 * Cloudflare Notifications webhook deliveries
 * (https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/).
 * `cf-webhook-auth` echoes the destination secret the Hub registered. The
 * source is the notification's alert type; the feature is whether the alert
 * fired or resolved, so a Channel or Automation can follow either edge. The
 * destination's test message carries neither and reaches `*` subscriptions only.
 */

export const CLOUDFLARE_ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const DATA_FIELDS = 6;

/* A few scalar fields of the alert's `data` (worker, zone, threshold), never nested payloads. */
function dataSummary(data: unknown): string | undefined {
  const fields = Object.entries(record(data))
    .filter(([key, value]) => /^[A-Za-z0-9_.-]{1,40}$/u.test(key) && text(value))
    .slice(0, DATA_FIELDS)
    .map(([key, value]) => `${key}: ${oneLine(text(value), 120)}`);
  return fields.length ? fields.join(" · ") : undefined;
}

export async function receiveCloudflareDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  const secret = delivery.credentials.webhookSecret;
  if (!secret || !timingSafeEqual(lowerHeader(delivery.headers, "cf-webhook-auth"), secret)) {
    return { ok: false, status: 401, error: "Invalid Cloudflare webhook secret" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return { ok: false, status: 400, error: "Cloudflare body must be JSON" };
  const alertType = sourceToken(payload.alert_type);
  const resolved = text(payload.alert_event) === "ALERT_STATE_EVENT_END";
  const name = text(payload.name) || text(payload.policy_name) || alertType || "Cloudflare notification";
  const correlation = text(payload.alert_correlation_id);
  const account = text(payload.account_id);
  const occurrence = correlation
    ? `${correlation}:${resolved ? "end" : "start"}`
    : `${alertType || "test"}:${text(payload.ts)}:${text(payload.policy_id)}`;
  return { ok: true, events: [connectorEvent({
    eventId: `cloudflare:${occurrence}`.slice(0, 160),
    sourceRef: `cloudflare:${alertType || "test"}`,
    feature: resolved ? "resolved" : "fired",
    summary: `${resolved ? "Resolved" : "Fired"}: ${name}`,
    provider: "Cloudflare", title: `${resolved ? "✅ Resolved" : "🔴 Fired"} · ${name}`,
    url: CLOUDFLARE_ACCOUNT_ID.test(account) ? `https://dash.cloudflare.com/${account}/notifications` : undefined,
    details: [dataSummary(payload.data), excerpt(payload.text, 1_000)],
  })] };
}
