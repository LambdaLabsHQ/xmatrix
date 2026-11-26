import { providerJson, providerUrl, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { taskContextExcerpt } from "./task-context";
import { sentryEventMetadata, sentryExceptionMechanism, sentryIssueMetadata } from "./sentry-event-metadata";
import { isSentryInstallationGrant, sentryInstallationHasScope, sentryOrganization,
  validateSentryInstallationCredentials, verifySentryInstallation } from "../sentry-installation";

const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/u;
const GROUP_ID = /^[1-9][0-9]{0,31}$/u;
const PROJECT_SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/u;
const PLATFORM_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const PROJECT_NAME = /^[^\p{Cc}]{1,64}$/u;
const SEARCH = /^[^\p{Cc}]{1,300}$/u;
const LIST_LIMIT = 25;
const PROJECT_LIST_LIMIT = 50;

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

/** Public Sentry ingest DSN only: never exports `dsn.secret`, credentials, queries, or arbitrary URLs. */
function validPublicDsn(value: unknown, allowHttp: boolean): string | undefined {
  if (typeof value !== "string" || value.length > 512 || /[\s\p{Cc}]/u.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) return undefined;
    if (!/^[a-f0-9]{16,128}$/iu.test(parsed.username) || parsed.password) return undefined;
    if (!/^\/[1-9][0-9]{0,31}$/u.test(parsed.pathname) || parsed.search || parsed.hash) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

/** Reads the first active public ingest DSN for a project; never exports private/secret DSNs. */
async function readProjectPublicDsn(
  credentials: Readonly<Record<string, string>>,
  projectSlug: string,
): Promise<{ dsn: string; label?: string }> {
  const organization = encodeURIComponent(sentryOrganization(credentials));
  const keys = (await providerJson(
    api(credentials, `api/0/projects/${organization}/${encodeURIComponent(projectSlug)}/keys/`),
    { headers: headers(credentials) },
  )).items;
  if (!Array.isArray(keys)) throw new ProviderRequestError(502, "Sentry did not return project client keys");
  const allowHttp = !credentials.oauthToken && Boolean(credentials.baseUrl?.startsWith("http://"));
  for (const key of keys) {
    if (!key || typeof key !== "object" || Array.isArray(key)) continue;
    const rec = key as Record<string, unknown>;
    if (rec.isActive === false) continue;
    const dsnObj = rec.dsn && typeof rec.dsn === "object" && !Array.isArray(rec.dsn)
      ? rec.dsn as Record<string, unknown> : undefined;
    const publicDsn = validPublicDsn(dsnObj?.public, allowHttp);
    if (!publicDsn) continue;
    const label = typeof rec.label === "string" && PROJECT_NAME.test(rec.label.trim()) ? rec.label.trim() : undefined;
    return { dsn: publicDsn, ...(label ? { label } : {}) };
  }
  throw new ProviderRequestError(502, `Sentry did not return an active public DSN for project ${projectSlug}`);
}

const LIST_PROJECTS: ConnectorAction = {
  effect: "read",
  requires: ["authToken|oauthToken", "organization|oauthOrganization"],
  parse(statement) {
    return statement.target.trim() === "*" && !statement.text.trim()
      ? {}
      : "use * to list projects: @sentry:list_projects:*";
  },
  async execute({ credentials }) {
    const organization = encodeURIComponent(sentryOrganization(credentials));
    const projects = (await providerJson(api(credentials, `api/0/organizations/${organization}/projects/`), {
      headers: headers(credentials),
    })).items;
    if (!Array.isArray(projects)) throw new ProviderRequestError(502, "Sentry did not return a project list");
    const shown = projects.slice(0, PROJECT_LIST_LIMIT);
    const lines: string[] = [];
    for (const item of shown) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const slug = typeof rec.slug === "string" ? rec.slug.trim().toLowerCase() : "";
      const name = typeof rec.name === "string" ? rec.name.replace(/\s+/gu, " ").trim() : "";
      if (!PROJECT_SLUG.test(slug) || !name) continue;
      const platform = typeof rec.platform === "string" && PLATFORM_SLUG.test(rec.platform.trim())
        ? rec.platform.trim() : undefined;
      lines.push([slug, name.slice(0, 80), platform].filter(Boolean).join(" · "));
    }
    if (lines.length !== shown.length) {
      throw new ProviderRequestError(502, `Sentry returned ${shown.length - lines.length} unreadable project(s) of ${shown.length}`);
    }
    if (!lines.length) return { summary: "No Sentry projects exist in this organization." };
    return {
      summary: [
        `Sentry projects in ${sentryOrganization(credentials)}${projects.length > PROJECT_LIST_LIMIT ? ` (first ${PROJECT_LIST_LIMIT} of ${projects.length})` : ""}:`,
        ...lines.map(line => `- ${line}`),
      ].join("\n"),
    };
  },
};

const GET_DSN: ConnectorAction = {
  effect: "read",
  requires: ["authToken|oauthToken", "organization|oauthOrganization"],
  parse(statement) {
    const project = statement.target.trim().toLowerCase();
    return PROJECT_SLUG.test(project) && !statement.text.trim()
      ? { project }
      : "name one project slug: @sentry:get_dsn:agent-router";
  },
  async execute({ credentials }, input) {
    const { dsn, label } = await readProjectPublicDsn(credentials, input.project!);
    return {
      summary: `Sentry public DSN for ${input.project}${label ? ` (${label})` : ""}: ${dsn}`,
    };
  },
};

/** Parses optional `platform=<slug>`, `team=<slug>`, and `name=<value>` tokens for `create_project`. */
function parseCreateProjectArgs(text: string): { platform?: string; team?: string; name?: string } | string {
  const usage = "use @sentry:create_project:<slug> [platform=<slug>] [team=<slug>] [name=<display name>]";
  const trimmed = text.trim();
  if (!trimmed) return {};
  const result: { platform?: string; team?: string; name?: string } = {};
  const pattern = /(platform|team|name)=(?:"([^"]+)"|'([^']+)'|(\S+))/gu;
  let consumed = 0;
  for (const match of trimmed.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (trimmed.slice(consumed, start).trim()) return usage;
    consumed = start + match[0].length;
    const key = match[1] as "platform" | "team" | "name";
    const rawValue = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (result[key] !== undefined || !rawValue) return usage;
    if (key === "platform") {
      const normalized = rawValue.toLowerCase();
      if (!PLATFORM_SLUG.test(normalized)) return usage;
      result.platform = normalized;
    } else if (key === "team") {
      const normalized = rawValue.toLowerCase();
      if (!PROJECT_SLUG.test(normalized)) return usage;
      result.team = normalized;
    } else {
      if (!PROJECT_NAME.test(rawValue)) return usage;
      result.name = rawValue;
    }
  }
  if (trimmed.slice(consumed).trim()) return usage;
  return result;
}

const CREATE_PROJECT: ConnectorAction = {
  effect: "write",
  requires: ["authToken|oauthToken", "organization|oauthOrganization"],
  parse(statement) {
    const project = statement.target.trim().toLowerCase();
    if (!PROJECT_SLUG.test(project)) {
      return "name a valid project slug: @sentry:create_project:agent-router [platform=rust] [team=<slug>]";
    }
    const parsed = parseCreateProjectArgs(statement.text);
    if (typeof parsed === "string") return parsed;
    return { project, ...parsed };
  },
  async execute({ credentials }, input) {
    if (isSentryInstallationGrant(credentials) &&
        (!sentryInstallationHasScope(credentials, "project:write") ||
          (!input.team && !sentryInstallationHasScope(credentials, "team:read")))) {
      throw new ProviderRequestError(403,
        "Sentry Public Integration needs Project: Read & Write (project:write) and Team: Read (team:read) to create projects; update the integration permissions in Sentry and reconnect.");
    }
    const orgSlug = sentryOrganization(credentials);
    const organization = encodeURIComponent(orgSlug);
    let team = input.team;
    if (!team) {
      const teams = (await providerJson(api(credentials, `api/0/organizations/${organization}/teams/`), {
        headers: headers(credentials),
      })).items;
      if (!Array.isArray(teams)) throw new ProviderRequestError(502, "Sentry did not return organization teams");
      const slugs = teams
        .map(item => (item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).slug === "string")
          ? ((item as Record<string, unknown>).slug as string).trim().toLowerCase() : "")
        .filter(slug => PROJECT_SLUG.test(slug));
      if (slugs.length === 0) {
        throw new ProviderRequestError(400, `No Sentry team found in ${orgSlug}; specify team=<slug>.`);
      }
      if (slugs.length > 1) {
        throw new ProviderRequestError(400,
          `Organization ${orgSlug} has multiple Sentry teams; specify team=<slug> (available: ${slugs.slice(0, 10).join(", ")}).`);
      }
      team = slugs[0]!;
    }
    let created: Record<string, unknown>;
    try {
      created = await providerJson(api(credentials, `api/0/teams/${organization}/${encodeURIComponent(team)}/projects/`), {
        method: "POST",
        headers: headers(credentials),
        json: {
          name: input.name || input.project!,
          slug: input.project!,
          ...(input.platform ? { platform: input.platform } : {}),
        },
      });
    } catch (error) {
      if (error instanceof ProviderRequestError && error.status === 409) {
        throw new ProviderRequestError(409,
          `Sentry project \`${input.project}\` already exists in ${orgSlug}; run \`@sentry:get_dsn:${input.project}\` to read its DSN.`);
      }
      throw error;
    }
    const createdSlug = typeof created.slug === "string" ? created.slug.trim().toLowerCase() : "";
    if (!PROJECT_SLUG.test(createdSlug) || createdSlug !== input.project) {
      throw new ProviderRequestError(502, "Sentry did not confirm the created project slug");
    }
    const createdName = typeof created.name === "string" && created.name.trim() ? created.name.trim() : input.name || createdSlug;
    const { dsn } = await readProjectPublicDsn(credentials, createdSlug);
    return {
      summary: [
        `Created Sentry project \`${createdSlug}\` (${createdName}, team \`${team}\`${input.platform ? `, platform \`${input.platform}\`` : ""}) in ${orgSlug}.`,
        `Public DSN: ${dsn}`,
        `Organization-level Sentry webhook events cover \`${createdSlug}\` automatically.`,
      ].join("\n"),
    };
  },
};

export const SENTRY_ACTIONS: Record<string, ConnectorAction> = {
  read_issue: READ_ISSUE,
  list_issues: LIST_ISSUES,
  list_projects: LIST_PROJECTS,
  get_dsn: GET_DSN,
  create_project: CREATE_PROJECT,
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
