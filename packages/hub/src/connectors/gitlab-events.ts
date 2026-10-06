import type { ConnectorDelivery, ConnectorDeliveryResult, ConnectorEvent } from "./provider";
import { timingSafeEqual } from "@xmatrix/protocol";
import { connectorEvent, excerpt, lowerHeader, oneLine, parseJsonObject, record, safeUrl, sourceToken, text } from "./event-format";

/*
 * GitLab project and group webhooks: `X-Gitlab-Token` echoes the secret token
 * the admin pasted into GitLab (the Hub generated it). A source is the
 * project's `path_with_namespace`.
 */

function commits(payload: Record<string, unknown>): string[] {
  const list = Array.isArray(payload.commits) ? payload.commits.slice(0, 5) : [];
  return list.map((commit) => {
    const value = record(commit);
    return `- ${text(value.id).slice(0, 8)} ${oneLine(text(value.title) || text(value.message), 120)}`;
  });
}

export async function receiveGitLabDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  const secret = delivery.credentials.webhookToken;
  if (!secret || !timingSafeEqual(lowerHeader(delivery.headers, "x-gitlab-token"), secret)) {
    return { ok: false, status: 401, error: "Invalid GitLab token" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return { ok: false, status: 400, error: "GitLab body must be JSON" };
  const kind = text(payload.object_kind);
  const project = record(payload.project);
  const path = sourceToken(project.path_with_namespace);
  const attributes = record(payload.object_attributes);
  const deliveryId = lowerHeader(delivery.headers, "x-gitlab-event-uuid") ||
    lowerHeader(delivery.headers, "x-gitlab-webhook-uuid") || `${kind}:${text(attributes.id)}:${text(attributes.updated_at)}`;
  const base = { eventId: `gitlab:${deliveryId}`, sourceRef: `gitlab:${path || "*"}` };
  const provider = `GitLab · ${text(project.path_with_namespace) || "project"}`;
  const events: ConnectorEvent[] = [];
  if (kind === "merge_request") {
    const url = safeUrl(attributes.url);
    const action = text(attributes.action) || text(attributes.state);
    events.push(connectorEvent({ ...base, feature: "merge_requests",
      summary: `!${text(attributes.iid)} ${action}: ${text(attributes.title)}`,
      provider, title: `!${text(attributes.iid)} ${action} — ${text(attributes.title)}`, url,
      details: [`${text(attributes.source_branch)} → ${text(attributes.target_branch)}`] }));
  } else if (kind === "push" || kind === "tag_push") {
    const ref = text(payload.ref).replace(/^refs\/(heads|tags)\//u, "");
    const count = Number(payload.total_commits_count) || 0;
    const url = safeUrl(project.web_url);
    events.push(connectorEvent({ ...base, feature: "pushes",
      summary: `${text(payload.user_username) || "Someone"} pushed ${count} commit(s) to ${ref}`,
      provider, title: `${text(payload.user_username)} pushed ${count} commit(s) to ${ref}`, url,
      details: commits(payload) }));
  } else if (kind === "pipeline") {
    const status = text(attributes.status);
    if (!["success", "failed", "canceled"].includes(status)) return { ok: true, events: [] };
    const url = safeUrl(attributes.url) ?? safeUrl(`${text(project.web_url)}/-/pipelines/${text(attributes.id)}`);
    events.push(connectorEvent({ ...base, feature: "pipelines",
      summary: `Pipeline ${status} on ${text(attributes.ref)}`,
      provider, title: `Pipeline #${text(attributes.id)} ${status} on ${text(attributes.ref)}`, url }));
  } else if (kind === "issue" || kind === "work_item") {
    const url = safeUrl(attributes.url);
    const action = text(attributes.action) || text(attributes.state);
    events.push(connectorEvent({ ...base, feature: "issues",
      summary: `#${text(attributes.iid)} ${action}: ${text(attributes.title)}`,
      provider, title: `#${text(attributes.iid)} ${action} — ${text(attributes.title)}`, url,
      details: [action === "open" ? excerpt(attributes.description) : undefined] }));
  } else if (kind === "note") {
    const url = safeUrl(attributes.url);
    const target = text(attributes.noteable_type);
    events.push(connectorEvent({ ...base, feature: "comments",
      summary: `${text(record(payload.user).username)} commented on ${target}`,
      provider, title: `${text(record(payload.user).username)} commented on ${target}`, url,
      details: [excerpt(attributes.note)] }));
  } else if (kind === "release") {
    const url = safeUrl(payload.url);
    events.push(connectorEvent({ ...base, feature: "releases",
      summary: `Release ${text(payload.action)}: ${text(payload.name) || text(payload.tag)}`,
      provider, title: `Release ${text(payload.action)} — ${text(payload.name) || text(payload.tag)}`, url }));
  }
  return { ok: true, events };
}
