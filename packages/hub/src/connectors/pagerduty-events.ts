import type { ConnectorDelivery, ConnectorDeliveryResult } from "./provider";
import { hmacHex, timingSafeEqual } from "@xmatrix/protocol";
import { connectorEvent, lowerHeader, parseJsonObject, record, safeUrl, sourceToken, text } from "./event-format";

/*
 * PagerDuty v3 webhooks: `X-PagerDuty-Signature` carries one or more
 * `v1=<hex>` HMAC-SHA256 signatures of the body (several during secret
 * rotation). A source is a service id.
 */

export async function receivePagerDutyDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  const secret = delivery.credentials.webhookSecret;
  const expected = secret ? `v1=${await hmacHex("SHA-256", secret, delivery.rawBody)}` : "";
  const signatures = lowerHeader(delivery.headers, "x-pagerduty-signature").split(",").map((value) => value.trim().toLowerCase());
  if (!expected || !signatures.some((signature) => timingSafeEqual(signature, expected))) {
    return { ok: false, status: 401, error: "Invalid PagerDuty signature" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return { ok: false, status: 400, error: "PagerDuty body must be JSON" };
  const event = record(payload.event);
  const type = text(event.event_type);
  if (!type.startsWith("incident.")) return { ok: true, events: [] };
  const data = record(event.data);
  const service = record(data.service);
  const url = safeUrl(data.html_url);
  const verb = type.slice("incident.".length).replace(/_/gu, " ");
  const title = `#${text(data.number)} ${verb} — ${text(data.title)}`;
  return { ok: true, events: [connectorEvent({
    eventId: `pagerduty:${text(event.id) || `${text(data.id)}:${type}:${text(event.occurred_at)}`}`,
    sourceRef: `pagerduty:${sourceToken(service.id) || "*"}`,
    feature: ["triggered", "acknowledged", "resolved"].includes(verb) ? verb : "updated",
    summary: `Incident ${title}`,
    provider: `PagerDuty · ${text(service.summary) || "incident"}`, title, url,
    details: [text(data.urgency) ? `Urgency: ${text(data.urgency)}` : undefined],
  })] };
}
