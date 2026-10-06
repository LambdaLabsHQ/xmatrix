import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { pagerDutyApiOrigin, validatePagerDutyCredentials } from "../pagerduty-oauth";
import { taskContextExcerpt } from "./task-context";

const INCIDENT_ID = /^[A-Za-z][A-Za-z0-9]{0,31}$/u;

export function pagerDutyHeaders(credentials: Readonly<Record<string, string>>, from = false) {
  const token = credentials.oauthToken;
  if (token) {
    validatePagerDutyCredentials(credentials);
    const scope = from ? "incidents.write" : "incidents.read";
    if (!(credentials.oauthScopes ?? "").split(/\s+/u).includes(scope)) {
      throw new ProviderRequestError(403, "PagerDuty grant does not authorize this action");
    }
  } else if (!credentials.apiKey || (from && !credentials.fromEmail)) {
    throw new ProviderRequestError(400, "PagerDuty requires an API key and an acting email for manual writes");
  }
  return { authorization: token ? `Bearer ${token}` : `Token token=${credentials.apiKey}`,
    accept: "application/vnd.pagerduty+json;version=2",
    ...(from && !token ? { from: credentials.fromEmail! } : {}) };
}

function incidentLink(value: unknown, incident: string, credentials: Readonly<Record<string, string>>): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:eu\.)?pagerduty\.com$/u.test(url.hostname) &&
        url.pathname === `/incidents/${incident}` && (!credentials.oauthToken ||
          url.hostname === `${credentials.oauthSubdomain}.${credentials.oauthRegion === "eu" ? "eu." : ""}pagerduty.com`)) {
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch { /* Invalid receipt links never become fetch targets. */ }
  throw new ProviderRequestError(502, "PagerDuty did not confirm the incident link");
}

export const PAGERDUTY_READ_INCIDENT: ConnectorAction = {
  effect: "read",
  requires: ["apiKey|oauthToken"],
  parse(statement) {
    return INCIDENT_ID.test(statement.target) && !statement.text.trim() ? { incident: statement.target.toUpperCase() }
      : "name an incident id: @pagerduty:read_incident:Q1ABC2DEF";
  },
  async execute({ credentials }, input) {
    const target = input.incident!;
    const endpoint = `${pagerDutyApiOrigin(credentials)}/incidents/${encodeURIComponent(target)}`;
    const headers = pagerDutyHeaders(credentials);
    const payload = await providerJson(endpoint, { headers });
    const incident = payload.incident as Record<string, unknown> | undefined;
    if (!incident || incident.id !== target || incident.type !== "incident" ||
        typeof incident.title !== "string" || typeof incident.status !== "string" ||
        !["triggered", "acknowledged", "resolved"].includes(incident.status) ||
        (incident.urgency !== undefined && !["high", "low"].includes(String(incident.urgency)))) {
      throw new ProviderRequestError(502, "PagerDuty did not confirm the selected incident");
    }
    const url = incidentLink(incident.html_url, target, credentials);
    const response = await providerJson(`${endpoint}/notes`, { headers });
    const notes = response.notes;
    if (!Array.isArray(notes) || notes.length > 1_000 || notes.some(note => !note ||
        typeof note !== "object" || typeof note.content !== "string")) {
      throw new ProviderRequestError(502, "PagerDuty did not confirm incident notes");
    }
    const excerpt = [`Incident ${target}: ${incident.title}`, `Status: ${incident.status}`,
      ...(incident.urgency ? [`Urgency: ${incident.urgency}`] : []),
      ...notes.slice(0, 20).map((note, index) => `Note ${index + 1}: ${note.content}`)].join("\n\n");
    return { summary: taskContextExcerpt("PagerDuty", excerpt, notes.length > 20, false, "notes"), url };
  },
};
