import type { ConnectorEvent } from "./provider";
import { createSignedJsonReceiver } from "./hmac";
import { connectorEvent, excerpt, lowerHeader, record, safeUrl, sourceToken, text } from "./event-format";

/*
 * Linear webhooks: `Linear-Signature` is the HMAC-SHA256 of the body with the
 * webhook's signing secret, `Linear-Delivery` identifies the delivery, and a
 * delivery older than a minute is refused as a replay. A source is a team key.
 */

const MAX_AGE_MS = 60_000;

export const receiveLinearDelivery = createSignedJsonReceiver({
  name: "Linear", secretField: "signingSecret", signatureHeader: "linear-signature",
}, (delivery, payload, now) => {
  const sent = Number(payload.webhookTimestamp);
  if (!Number.isSafeInteger(sent) || sent <= 0 || Math.abs(now - sent) > MAX_AGE_MS) {
    return { ok: false, status: 401, error: "Stale Linear delivery" };
  }
  const type = text(payload.type);
  const action = text(payload.action);
  const data = record(payload.data);
  const deliveryId = lowerHeader(delivery.headers, "linear-delivery") || `${type}:${text(data.id)}:${action}:${sent}`;
  const verb = action === "create" ? "created" : action === "update" ? "updated" : action === "remove" ? "removed" : action;
  const events: ConnectorEvent[] = [];
  if (type === "Issue") {
    const team = sourceToken(record(data.team).key || String(text(data.identifier)).split("-")[0]);
    const url = safeUrl(data.url) ?? safeUrl(payload.url);
    const state = text(record(data.state).name);
    events.push(connectorEvent({ eventId: `linear:${deliveryId}`, sourceRef: `linear:${team || "*"}`, feature: "issue",
      summary: `${text(data.identifier)} ${verb}: ${text(data.title)}`,
      provider: `Linear · ${team.toUpperCase() || "issue"}`,
      title: `${text(data.identifier)} ${verb} — ${text(data.title)}`, url,
      details: [state ? `State: ${state}` : undefined, action === "create" ? excerpt(data.description) : undefined] }));
  } else if (type === "Comment") {
    const issue = record(data.issue);
    const team = sourceToken(record(issue.team).key || String(text(issue.identifier)).split("-")[0]);
    const url = safeUrl(data.url) ?? safeUrl(payload.url);
    events.push(connectorEvent({ eventId: `linear:${deliveryId}`, sourceRef: `linear:${team || "*"}`, feature: "comment",
      summary: `Comment ${verb} on ${text(issue.identifier) || "an issue"}`,
      provider: `Linear · ${team.toUpperCase() || "comment"}`,
      title: `Comment ${verb} on ${text(issue.identifier)} ${text(issue.title)}`.trim(), url,
      details: [action === "remove" ? undefined : excerpt(data.body)] }));
  } else if (type === "Project" || type === "ProjectUpdate" || type === "Cycle") {
    const url = safeUrl(data.url) ?? safeUrl(payload.url);
    const name = text(data.name) || text(record(data.project).name) || type;
    events.push(connectorEvent({ eventId: `linear:${deliveryId}`, sourceRef: "linear:*", feature: "project",
      summary: `${type} ${verb}: ${name}`,
      provider: "Linear", title: `${type} ${verb} — ${name}`, url,
      details: [type === "ProjectUpdate" ? excerpt(data.body) : undefined] }));
  }
  return { ok: true, events };
});
