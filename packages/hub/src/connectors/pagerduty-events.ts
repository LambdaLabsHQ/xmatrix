import { createSignedJsonReceiver } from "./delivery-proof";
import { connectorEvent, record, safeUrl, sourceToken, text } from "./event-format";

/*
 * PagerDuty v3 webhooks: `X-PagerDuty-Signature` carries one or more
 * `v1=<hex>` HMAC-SHA256 signatures of the body (several during secret
 * rotation). A source is a service id.
 */

export const receivePagerDutyDelivery = createSignedJsonReceiver({
  name: "PagerDuty", secretField: "webhookSecret", proof: { header: "x-pagerduty-signature", prefix: "v1=" },
}, (_, payload) => {
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
});
