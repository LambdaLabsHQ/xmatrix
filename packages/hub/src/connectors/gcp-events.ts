import { createSignedJsonReceiver, deliveryProven } from "./delivery-proof";
import { connectorEvent, excerpt, oneLine, record, text } from "./event-format";
import { GCP_PROJECT } from "./gcp-common";

/* Monitoring webhook schema 1.2. Token authentication is Google's documented
 * HTTPS query-token method. The ingress key still selects only this Space's
 * connection; the separate generated token proves each delivery before JSON
 * parsing. Subscription routing uses the metrics-scope project, never the
 * monitored resource's potentially different project. */
export const receiveGcpDelivery = createSignedJsonReceiver({
  name: "Google Cloud", secretField: "webhookSecret",
  proof: (delivery, secret) => deliveryProven({ header: "x-gcp-token", token: true },
    new Headers({ "x-gcp-token": delivery.url.searchParams.get("auth_token") ?? "" }), delivery.rawBody, secret),
}, (_, payload) => {
  const incident = record(payload.incident);
  const project = text(incident.scoping_project_id);
  const id = text(incident.incident_id);
  const state = text(incident.state);
  const started = incident.started_at;
  const ended = incident.ended_at;
  if (payload.version !== "1.2" || !GCP_PROJECT.test(project) || !/^[A-Za-z0-9_.-]{1,100}$/u.test(id) ||
      !["open", "closed"].includes(state) || typeof started !== "number" || !Number.isSafeInteger(started) || started <= 0 ||
      (state === "closed" && (typeof ended !== "number" || !Number.isSafeInteger(ended) || ended < started))) {
    return { ok: false, status: 400, error: "Invalid Google Cloud Monitoring incident (schema 1.2 required)" };
  }
  const resolved = state === "closed";
  const title = oneLine(text(incident.policy_name) || text(incident.summary) || id);
  const resource = record(incident.resource);
  return { ok: true, events: [connectorEvent({
    eventId: `gcp:${project}:${id}:${state}`,
    sourceRef: `gcp:${project}`, feature: resolved ? "resolved" : "fired",
    summary: `${resolved ? "Resolved" : "Fired"}: ${title}`, provider: "Google Cloud",
    title: `${resolved ? "✅ Resolved" : "🔴 Fired"} · ${title}`,
    url: `https://console.cloud.google.com/monitoring/alerting/incidents/${encodeURIComponent(id)}?project=${project}`,
    details: [oneLine(`${project} · ${text(resource.type)} · ${text(incident.resource_display_name)}`, 300),
      excerpt(incident.summary, 1_000)],
  })] };
});
