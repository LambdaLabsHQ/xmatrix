import { providerJson, providerUrl, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { taskContextExcerpt } from "./task-context";
import { sentryEventMetadata, sentryExceptionMechanism } from "./sentry-event-metadata";
import { isSentryInstallationGrant, sentryOrganization, validateSentryInstallationCredentials,
  verifySentryInstallation } from "../sentry-installation";

const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/u;
const GROUP_ID = /^[1-9][0-9]{0,31}$/u;

function api(credentials: Readonly<Record<string, string>>, path: string): URL {
  if (isSentryInstallationGrant(credentials)) validateSentryInstallationCredentials(credentials);
  // The registered OAuth app is Sentry SaaS; manual tokens may target a configured self-hosted installation.
  return providerUrl(credentials.oauthToken ? "https://sentry.io" : credentials.baseUrl || "https://sentry.io", path);
}

function headers(credentials: Readonly<Record<string, string>>) {
  return { authorization: `Bearer ${credentials.oauthToken || credentials.authToken}` };
}

/* Short ids (WEB-1A) and numeric ids both resolve to the issue's group id. */
async function groupId(credentials: Readonly<Record<string, string>>, issue: string): Promise<string> {
  if (GROUP_ID.test(issue)) return issue;
  const organization = encodeURIComponent(sentryOrganization(credentials));
  const resolved = await providerJson(api(credentials, `api/0/organizations/${organization}/shortids/${encodeURIComponent(issue)}/`),
    { headers: headers(credentials) });
  const id = String(resolved.groupId ?? "");
  if (!GROUP_ID.test(id)) throw new ProviderRequestError(502, "Sentry did not confirm the selected issue id");
  return id;
}

/** Sentry strings, or the annotated `{ "": "text" }` form used when a value is truncated. */
function fieldString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { "": unknown })[""] === "string") {
    return (value as { "": string })[""];
  }
}

/** Exception metadata only: never export request headers/bodies, local variables, users or breadcrumbs. */
function exceptionContext(entries: unknown): { lines: string[]; partial: boolean } {
  if (!Array.isArray(entries)) throw new ProviderRequestError(502, "Sentry did not confirm event entries");
  const lines: string[] = [];
  let partial = entries.length > 20;
  let exceptions = 0;
  for (const entry of entries.slice(0, 20)) {
    if (!entry || entry.type !== "exception") continue;
    const values = entry.data?.values;
    if (!Array.isArray(values)) { partial = true; continue; }
    partial ||= values.length > 3 - exceptions;
    for (const value of values.slice(0, 3 - exceptions)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const type = fieldString(value.type);
      const message = fieldString(value.value);
      const frames = Array.isArray(value.stacktrace?.frames) ? value.stacktrace.frames
        : Array.isArray(value.rawStacktrace?.frames) ? value.rawStacktrace.frames : [];
      if (!type && !message && !frames.length) continue;
      exceptions++;
      const headline = [type, message].filter(Boolean).join(": ");
      lines.push(`Exception ${exceptions}${headline ? `: ${headline}` : ""}`);
      const mechanism = sentryExceptionMechanism(value);
      if (mechanism) lines.push(mechanism);
      partial ||= frames.length > 20;
      for (const frame of frames.slice(-20)) {
        if (!frame || typeof frame !== "object") continue;
        const label = [frame.module, frame.function, frame.filename].filter(field => typeof field === "string");
        const line = frame.lineNo ?? frame.lineno;
        const column = frame.colNo ?? frame.colno;
        if (Number.isSafeInteger(line)) label.push(`line ${line}`);
        if (Number.isSafeInteger(column)) label.push(`column ${column}`);
        if (label.length) lines.push(`Frame: ${label.join(" · ")}`);
      }
    }
    if (exceptions === 3) { partial ||= entries.indexOf(entry) < entries.length - 1; break; }
  }
  return { lines, partial };
}

const READ_ISSUE: ConnectorAction = {
  effect: "read",
  requires: ["authToken|oauthToken", "organization|oauthOrganization"],
  parse(statement) {
    return SHORT_ID.test(statement.target) && !statement.text.trim() &&
      (!/^\d+$/u.test(statement.target) || GROUP_ID.test(statement.target))
      ? { issue: statement.target.toUpperCase() } : "name one issue: @sentry:read_issue:WEB-1A";
  },
  async execute({ credentials }, input) {
    const id = await groupId(credentials, input.issue!);
    const endpoint = `api/0/organizations/${encodeURIComponent(sentryOrganization(credentials))}/issues/${id}/`;
    const issue = await providerJson(api(credentials, endpoint), { headers: headers(credentials) });
    if (issue.id !== id || typeof issue.title !== "string" || typeof issue.status !== "string" ||
        (input.issue !== id && issue.shortId !== input.issue)) {
      throw new ProviderRequestError(502, "Sentry did not confirm the selected issue");
    }
    const event = await providerJson(api(credentials, `${endpoint}events/latest/`), { headers: headers(credentials) });
    if (event.groupID !== id || typeof event.eventID !== "string" || !/^[a-f0-9]{32}$/iu.test(event.eventID)) {
      throw new ProviderRequestError(502, "Sentry did not confirm the issue event");
    }
    const stack = exceptionContext(event.entries);
    const context = [`Issue ${issue.shortId || id}: ${issue.title}`, `Status: ${issue.status}`,
      typeof issue.culprit === "string" ? `Culprit: ${issue.culprit}` : "",
      typeof event.platform === "string" ? `Platform: ${event.platform}` : "",
      `Latest event: ${event.eventID}`, ...sentryEventMetadata(event), ...stack.lines].filter(Boolean).join("\n\n");
    return { summary: taskContextExcerpt("Sentry", context, false, stack.partial) +
      "\nRequest data, local variables, breadcrumbs and user profiles omitted." };
  },
};

function statusAction(status: "resolved" | "unresolved" | "ignored", verb: string): ConnectorAction {
  return {
    effect: "write",
    requires: ["authToken|oauthToken", "organization|oauthOrganization"],
    parse(statement) {
      return SHORT_ID.test(statement.target) ? { issue: statement.target.toUpperCase() }
        : `name an issue: @sentry:${verb}:WEB-1A`;
    },
    async execute({ credentials }, input) {
      const id = await groupId(credentials, input.issue!);
      const organization = encodeURIComponent(sentryOrganization(credentials));
      await providerJson(api(credentials, `api/0/organizations/${organization}/issues/${encodeURIComponent(id)}/`), {
        method: "PUT", headers: headers(credentials), json: { status } });
      return { summary: `Marked ${input.issue} ${status}` };
    },
  };
}

export const SENTRY_ACTIONS: Record<string, ConnectorAction> = {
  read_issue: READ_ISSUE,
  resolve: statusAction("resolved", "resolve"),
  unresolve: statusAction("unresolved", "unresolve"),
  ignore: statusAction("ignored", "ignore"),
};


export async function verifySentry(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (isSentryInstallationGrant(credentials)) return verifySentryInstallation(credentials);
  const token = credentials.oauthToken || credentials.authToken;
  if (!token) return;
  const organizations = await providerJson(api(credentials, "api/0/organizations/"), {
    headers: headers(credentials),
  });
  if (!Array.isArray(organizations.items)) {
    throw new ProviderRequestError(502, "Sentry did not return the authorized organization list");
  }
}
