import { providerJson, providerUrl, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { parseIssueComment, requireText } from "./common";
import { JIRA_READ_ISSUE } from "./jira-read";

const ISSUE = /^[A-Za-z][A-Za-z0-9_]{0,19}-\d{1,9}$/u;

/* OAuth (3LO) calls go through api.atlassian.com for the connected site;
   an API token calls the site directly with Basic auth. */
function api(credentials: Readonly<Record<string, string>>, path: string): URL {
  if (credentials.oauthToken && credentials.cloudId) {
    return providerUrl(`https://api.atlassian.com/ex/jira/${encodeURIComponent(credentials.cloudId)}/`, `rest/api/3/${path}`);
  }
  return providerUrl(credentials.siteUrl!, `rest/api/3/${path}`);
}

function headers(credentials: Readonly<Record<string, string>>) {
  return credentials.oauthToken && credentials.cloudId ? { authorization: `Bearer ${credentials.oauthToken}` }
    : { authorization: `Basic ${btoa(`${credentials.email}:${credentials.apiToken}`)}` };
}

/* Jira Cloud v3 takes rich text as Atlassian Document Format. */
function document(text: string) {
  return { type: "doc", version: 1, content: text.split(/\n{2,}/u).map((paragraph) => ({
    type: "paragraph", content: [{ type: "text", text: paragraph }] })) };
}

const REQUIRES = ["siteUrl", "email|oauthToken", "apiToken|cloudId"] as const;

export const JIRA_ACTIONS: Record<string, ConnectorAction> = {
  read_issue: JIRA_READ_ISSUE,
  comment: {
    effect: "write",
    requires: REQUIRES,
    parse(statement) {
      return parseIssueComment(statement, ISSUE, "@jira:comment:ENG-9 <text>");
    },
    async execute({ credentials }, input) {
      await providerJson(api(credentials, `issue/${encodeURIComponent(input.issue!)}/comment`), {
        method: "POST", headers: headers(credentials), json: { body: document(input.text!) } });
      return { summary: `Commented on ${input.issue}`,
        url: providerUrl(credentials.siteUrl!, `browse/${encodeURIComponent(input.issue!)}`).toString() };
    },
  },
  transition: {
    effect: "write",
    requires: REQUIRES,
    parse(statement) {
      if (!ISSUE.test(statement.target)) return "name an issue: @jira:transition:ENG-9 Done";
      const status = requireText(statement);
      return status ? { issue: statement.target.toUpperCase(), status: status.split("\n")[0]!.trim() }
        : "write the status to move to after the issue";
    },
    async execute({ credentials }, input) {
      const available = await providerJson(api(credentials, `issue/${encodeURIComponent(input.issue!)}/transitions`),
        { headers: headers(credentials) });
      const transitions = Array.isArray(available.transitions) ? available.transitions as Record<string, unknown>[] : [];
      const wanted = input.status!.toLowerCase();
      const transition = transitions.find((candidate) => String(candidate.name).toLowerCase() === wanted ||
        String((candidate.to as Record<string, unknown> | undefined)?.name ?? "").toLowerCase() === wanted);
      if (!transition) {
        throw new ProviderRequestError(400, `No "${input.status}" transition; available: ${
          transitions.map((candidate) => String(candidate.name)).slice(0, 10).join(", ") || "none"}`);
      }
      await providerJson(api(credentials, `issue/${encodeURIComponent(input.issue!)}/transitions`), {
        method: "POST", headers: headers(credentials), json: { transition: { id: String(transition.id) } } });
      return { summary: `Moved ${input.issue} to ${String(transition.name)}` };
    },
  },
};


/** OAuth checks the actual granted site without fetching Atlassian account profiles. */
export async function verifyJira(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (credentials.oauthToken) {
    const resources = await providerJson("https://api.atlassian.com/oauth/token/accessible-resources", {
      headers: { authorization: `Bearer ${credentials.oauthToken}` },
    });
    const sites = Array.isArray(resources.items) ? resources.items as Record<string, unknown>[] : [];
    if (!credentials.cloudId || !sites.some((site) => site.id === credentials.cloudId)) {
      throw new ProviderRequestError(403, "Jira did not grant access to the connected site");
    }
  } else if (credentials.apiToken) {
    if (!credentials.email || !credentials.siteUrl) {
      throw new ProviderRequestError(400, "Jira API token checks require the account email and site URL");
    }
    const user = await providerJson(api(credentials, "myself"), { headers: headers(credentials) });
    if (typeof user.accountId !== "string" || !user.accountId) {
      throw new ProviderRequestError(401, "Jira did not authenticate the API credential");
    }
  }
}
