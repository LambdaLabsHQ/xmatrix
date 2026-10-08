import type { ConnectorEvent } from "./provider";
import { createSignedJsonReceiver } from "./delivery-proof";
import { connectorEvent, excerpt, lowerHeader, record, safeUrl, sourceToken, text } from "./event-format";

/*
 * Sentry internal-integration webhooks: `Sentry-Hook-Signature` is the
 * HMAC-SHA256 of the body with the integration's client secret, and
 * `Sentry-Hook-Resource` names the payload. A source is a project slug.
 */

const ISSUE_FEATURES: Record<string, string> = {
  created: "issue.created", resolved: "issue.resolved", unresolved: "issue.regressed",
  assigned: "issue.assigned", ignored: "issue.ignored", archived: "issue.ignored",
};

export const receiveSentryDelivery = createSignedJsonReceiver({
  name: "Sentry", secretField: "clientSecret", proof: { header: "sentry-hook-signature" },
}, (delivery, payload) => {
  const resource = lowerHeader(delivery.headers, "sentry-hook-resource");
  const action = text(payload.action);
  const data = record(payload.data);
  const requestId = lowerHeader(delivery.headers, "request-id") ||
    `${resource}:${action}:${lowerHeader(delivery.headers, "sentry-hook-timestamp")}`;
  const events: ConnectorEvent[] = [];
  if (resource === "issue" && ISSUE_FEATURES[action]) {
    const issue = record(data.issue);
    const project = sourceToken(record(issue.project).slug);
    const url = safeUrl(issue.permalink) ?? safeUrl(issue.web_url);
    events.push(connectorEvent({ eventId: `sentry:${requestId}`, sourceRef: `sentry:${project || "*"}`, feature: ISSUE_FEATURES[action]!,
      summary: `${text(issue.shortId) || "Issue"} ${action}: ${text(issue.title)}`,
      provider: `Sentry · ${project || "issue"}`, title: `${text(issue.shortId)} ${action} — ${text(issue.title)}`,
      url, details: [text(issue.culprit) ? `\`${text(issue.culprit).replace(/`/gu, "'").slice(0, 200)}\`` : undefined,
        text(issue.level) ? `Level: ${text(issue.level)}` : undefined] }));
  } else if (resource === "event_alert") {
    const event = record(data.event);
    const rule = text(data.triggered_rule);
    const url = safeUrl(event.web_url) ?? safeUrl(event.issue_url);
    const project = sourceToken(event.project_slug ?? record(event.project).slug);
    events.push(connectorEvent({ eventId: `sentry:${requestId}`, sourceRef: `sentry:${project || "*"}`, feature: "alert",
      summary: `Alert ${rule}: ${text(event.title)}`,
      provider: `Sentry · alert${project ? ` · ${project}` : ""}`,
      title: `${rule ? `${rule} — ` : ""}${text(event.title)}`, url }));
  } else if (resource === "metric_alert") {
    const alert = record(data.metric_alert);
    const url = safeUrl(data.web_url);
    const title = text(data.description_title) || text(alert.title) || "Metric alert";
    events.push(connectorEvent({ eventId: `sentry:${requestId}`, sourceRef: "sentry:*", feature: "alert",
      summary: `Metric alert ${action}: ${title}`,
      provider: "Sentry · metric alert", title: `${action} — ${title}`, url,
      details: [excerpt(data.description_text, 400)] }));
  } else if (resource === "comment") {
    const url = safeUrl(record(data.issue).permalink);
    const project = sourceToken(data.project_slug);
    events.push(connectorEvent({ eventId: `sentry:${requestId}`, sourceRef: `sentry:${project || "*"}`, feature: "comment",
      summary: `Comment ${action} on issue ${text(data.issue_id)}`,
      provider: `Sentry · comment${project ? ` · ${project}` : ""}`,
      title: `Comment ${action} on issue ${text(data.issue_id)}`, url, details: [excerpt(data.comment)] }));
  }
  return { ok: true, events };
});
