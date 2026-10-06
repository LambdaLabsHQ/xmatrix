import { validateSentryEventIdentity, type SentryEventIdentity } from "@xmatrix/db";
import { record } from "./event-format";

/** Discriminate signed shapes, never unsigned Sentry resource/request/timestamp headers. */
export function sentryEventIdentity(body: Record<string, unknown>): SentryEventIdentity | undefined {
  const data = record(body.data);
  const kinds = ["issue", "event", "metric_alert"].filter(kind => Object.hasOwn(data, kind));
  if (kinds.length !== 1 || typeof body.action !== "string") return undefined;
  const ref = (value: unknown) => typeof value === "string" ? value :
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : "";
  const item = record(data[kinds[0]!]);
  let identity: SentryEventIdentity;
  if (kinds[0] === "issue") {
    const project = record(item.project);
    identity = { kind: "issue", action: body.action, objectId: ref(item.id),
      projectId: ref(project.id), projectSlug: ref(project.slug) };
  } else if (kinds[0] === "event") {
    // Parse only the documented path to learn references. Never fetch a payload URL.
    let url: URL;
    try { url = new URL(String(item.url)); } catch { return undefined; }
    const match = /^\/api\/0\/projects\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/events\/([a-f0-9]{32})\/$/u.exec(url.pathname);
    if (url.origin !== "https://sentry.io" || url.search || url.hash || url.username || url.password ||
        !match || match[3] !== item.event_id) return undefined;
    identity = { kind: "event_alert", action: body.action, objectId: match[3],
      projectId: ref(item.project), organizationSlug: match[1]!, projectSlug: match[2]! };
  } else {
    identity = { kind: "metric_alert", action: body.action, objectId: ref(item.id),
      organizationId: ref(item.organization_id), projects: Array.isArray(item.projects)
        ? item.projects.map(ref) : [] };
  }
  try { return validateSentryEventIdentity(identity); } catch { return undefined; }
}
