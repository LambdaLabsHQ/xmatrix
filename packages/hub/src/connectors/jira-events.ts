import { createSignedJsonReceiver } from "./hmac";
import { connectorEvent, excerpt, lowerHeader, record, safeUrl, sourceToken, text } from "./event-format";

/*
 * Jira Cloud admin webhooks with a secret: `X-Hub-Signature` is
 * `sha256=` + HMAC-SHA256 of the body. A source is a project key.
 *
 * Messages cache no Atlassian account profile: no actor, author, assignee or
 * reporter field is read, and every account mention (`[~accountid:…]`,
 * `[~username]`) in a title or comment becomes an anonymous `@user`.
 */

/** Text with every account mention reduced to an anonymous `@user`. */
function withoutAccounts(body: unknown): string {
  return text(body).replace(/\[~[^\]\r\n]{1,200}\]/gu, "@user");
}

function browseUrl(issue: Record<string, unknown>): string | undefined {
  const self = safeUrl(issue.self);
  const key = text(issue.key);
  if (!self || !key) return undefined;
  return safeUrl(`${new URL(self).origin}/browse/${encodeURIComponent(key)}`);
}

export const receiveJiraDelivery = createSignedJsonReceiver({
  name: "Jira", secretField: "webhookSecret", signatureHeader: "x-hub-signature", stripSha256Prefix: true,
}, (delivery, payload) => {
  const event = text(payload.webhookEvent);
  const issue = record(payload.issue);
  const fields = record(issue.fields);
  const summary = withoutAccounts(fields.summary);
  const project = sourceToken(record(fields.project).key || String(text(issue.key)).split("-")[0]);
  const url = browseUrl(issue);
  const eventId = `jira:${lowerHeader(delivery.headers, "x-atlassian-webhook-identifier") ||
    `${event}:${text(issue.id)}:${text(payload.timestamp)}`}`;
  const base = { eventId, sourceRef: `jira:${project || "*"}` };
  const provider = `Jira · ${project.toUpperCase() || "issue"}`;
  if (event.startsWith("jira:issue_")) {
    const verb = event.slice("jira:issue_".length);
    const status = text(record(fields.status).name);
    return { ok: true, events: [connectorEvent({ ...base, feature: "issues",
      summary: `${text(issue.key)} ${verb}: ${summary}`,
      provider, title: `${text(issue.key)} ${verb} — ${summary}`, url,
      details: [status ? `Status: ${withoutAccounts(status)}` : undefined] })] };
  }
  if (event.startsWith("comment_")) {
    const comment = record(payload.comment);
    const verb = event.slice("comment_".length);
    return { ok: true, events: [connectorEvent({ ...base, feature: "comments",
      summary: `Comment ${verb} on ${text(issue.key)}`,
      provider, title: `Comment ${verb} on ${text(issue.key)} ${summary}`.trim(), url,
      details: [verb === "deleted" ? undefined : excerpt(withoutAccounts(comment.body))] })] };
  }
  return { ok: true, events: [] };
});
