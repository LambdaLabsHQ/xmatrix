import { providerJson, providerUrl, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { taskContextExcerpt } from "./task-context";
import { sentryEventMetadata, sentryExceptionMechanism, sentryIssueMetadata } from "./sentry-event-metadata";
import { isSentryInstallationGrant, sentryOrganization, validateSentryInstallationCredentials,
  verifySentryInstallation } from "../sentry-installation";

const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/u;
const GROUP_ID = /^[1-9][0-9]{0,31}$/u;
const PROJECT_SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/u;
const SEARCH = /^[^\p{Cc}]{1,300}$/u;
const LIST_LIMIT = 25;

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

/** Generated locations identify deployed scripts, never inline code or URL credentials. */
function generatedLocation(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\s\p{Cc}]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:", "app:"].includes(url.protocol) || url.username || url.password) return undefined;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return /^[A-Za-z0-9_./@+-]{1,512}$/u.test(value) ? value : undefined;
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
      const mapped = Array.isArray(value.stacktrace?.frames) ? value.stacktrace.frames : [];
      const raw = Array.isArray(value.rawStacktrace?.frames) ? value.rawStacktrace.frames : [];
      const frames = mapped.length ? mapped : raw;
      if (!type && !message && !frames.length) continue;
      exceptions++;
      const headline = [type, message].filter(Boolean).join(": ");
      lines.push(`Exception ${exceptions}${headline ? `: ${headline}` : ""}`);
      const mechanism = sentryExceptionMechanism(value);
      if (mechanism) lines.push(mechanism);
      partial ||= frames.length > 20;
      // Dependency-heavy stacks can hide the application effect that entered
      // the failing path. Keep up to eight earlier source callers as well as
      // the terminal twenty frames; export the same metadata-only projection.
      const callers = frames.slice(0, -20).filter((frame: unknown) => {
        if (!frame || typeof frame !== "object") return false;
        const filename = (frame as { filename?: unknown }).filename;
        return typeof filename === "string" && /(?:^|\/)src\//u.test(filename) && !filename.includes("node_modules/");
      }).slice(-8);
      for (const frame of [...callers, ...frames.slice(-20)]) {
        if (!frame || typeof frame !== "object") continue;
        const label: string[] = mapped.length
          ? [frame.module, frame.function, frame.filename].filter(field => typeof field === "string")
          : [generatedLocation(frame.filename ?? frame.absPath)].filter((field): field is string => field !== undefined);
        if (!label.length) continue;
        const line = frame.lineNo ?? frame.lineno;
        const column = frame.colNo ?? frame.colno;
        if (Number.isSafeInteger(line)) label.push(`line ${line}`);
        if (Number.isSafeInteger(column)) label.push(`column ${column}`);
        if (label.length) lines.push(`Frame: ${label.join(" · ")}`);
      }
      // Source maps replace filenames and positions. Keep a small, separate
      // generated tail so a dependency frame still identifies its shipped asset.
      if (mapped.length) {
        partial ||= raw.length > 8;
        for (const frame of raw.slice(-8)) {
          const location = generatedLocation(frame?.filename ?? frame?.absPath);
          if (!location) continue;
          const label = [location];
          const line = frame.lineNo ?? frame.lineno;
          const column = frame.colNo ?? frame.colno;
          if (Number.isSafeInteger(line)) label.push(`line ${line}`);
          if (Number.isSafeInteger(column)) label.push(`column ${column}`);
          lines.push(`Generated frame: ${label.join(" · ")}`);
        }
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
    const context = [`Issue ${issue.shortId || id}: ${issue.title}`, `Status: ${issue.status}`, ...sentryIssueMetadata(issue),
      typeof issue.culprit === "string" ? `Culprit: ${issue.culprit}` : "",
      typeof event.platform === "string" ? `Platform: ${event.platform}` : "",
      `Latest event: ${event.eventID}`, ...sentryEventMetadata(event), ...stack.lines].filter(Boolean).join("\n\n");
    return { summary: taskContextExcerpt("Sentry", context, false, stack.partial) +
      "\nRequest data, local variables, breadcrumbs and user profiles omitted." };
  },
};

/** One issue as Sentry summarizes it: its own fields only, never event payloads, users or request data. */
function issueLine(issue: unknown): string | undefined {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return undefined;
  const field = (name: string) => {
    const value = (issue as Record<string, unknown>)[name];
    return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : undefined;
  };
  const shortId = field("shortId");
  const title = field("title");
  if (!shortId || !SHORT_ID.test(shortId) || !title) return undefined;
  const count = field("count");
  const users = (issue as Record<string, unknown>).userCount;
  return [
    `${shortId}: ${title.slice(0, 200)}`,
    field("level"),
    field("status"),
    count && /^\d+$/u.test(count) ? `${count} events` : undefined,
    Number.isSafeInteger(users) ? `${users} users` : undefined,
    field("firstSeen") ? `first seen ${field("firstSeen")}` : undefined,
    field("lastSeen") ? `last seen ${field("lastSeen")}` : undefined,
  ].filter(Boolean).join(" · ");
}

/**
 * The most frequent issues of one project (or the whole organization, `*`)
 * matching a Sentry search, such as everything first seen in a release
 * (`firstRelease:xmatrix-v1.2.3`) or since an hour (`firstSeen:-24h`).
 */
const LIST_ISSUES: ConnectorAction = {
  effect: "read",
  requires: ["authToken|oauthToken", "organization|oauthOrganization"],
  parse(statement) {
    const project = statement.target.toLowerCase();
    const search = statement.text.trim();
    return (project === "*" || PROJECT_SLUG.test(project)) && SEARCH.test(search)
      ? { project, search }
      : "name a project (or *) and one line of Sentry search: @sentry:list_issues:web firstRelease:xmatrix-v1.2.3";
  },
  async execute({ credentials }, input) {
    const organization = encodeURIComponent(sentryOrganization(credentials));
    const path = input.project === "*" ? `api/0/organizations/${organization}/issues/`
      : `api/0/projects/${organization}/${encodeURIComponent(input.project!)}/issues/`;
    const url = api(credentials, path);
    url.search = new URLSearchParams({ query: input.search!, sort: "freq", limit: String(LIST_LIMIT + 1),
      statsPeriod: "14d" }).toString();
    // providerJson returns a top-level JSON array as `items`.
    const issues = (await providerJson(url, { headers: headers(credentials) })).items;
    if (!Array.isArray(issues)) throw new ProviderRequestError(502, "Sentry did not return an issue list");
    const shown = issues.slice(0, LIST_LIMIT);
    const lines = shown.map(issueLine).filter((line): line is string => line !== undefined);
    // An answer it cannot read is no evidence that nothing matched: refuse it whole.
    if (lines.length !== shown.length) {
      throw new ProviderRequestError(502, `Sentry returned ${shown.length - lines.length} unreadable issue(s) of ${shown.length}`);
    }
    const scope = input.project === "*" ? "all projects" : input.project;
    if (!lines.length) return { summary: `No Sentry issue in ${scope} matches \`${input.search}\` (last 14 days).` };
    return { summary: [`Sentry issues in ${scope} matching \`${input.search}\` (last 14 days, most frequent first` +
      `${issues.length > LIST_LIMIT ? `, first ${LIST_LIMIT}` : ""}):`, ...lines.map(line => `- ${line}`)].join("\n") };
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
  list_issues: LIST_ISSUES,
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
