import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { parseIssueComment, requireText, titleAndBody } from "./common";
import { taskContextExcerpt } from "./task-context";

const ISSUE = /^[A-Za-z0-9]{1,16}-\d{1,9}$/u;
const TEAM = /^[A-Za-z0-9]{1,16}$/u;

/* A personal API key is sent as is; an OAuth token as a bearer token. */
function linearAuthorization(credentials: Readonly<Record<string, string>>): string {
  return credentials.oauthToken ? `Bearer ${credentials.oauthToken}` : credentials.apiKey!;
}

async function linear(authorization: string, query: string, variables: Record<string, unknown>) {
  const payload = await providerJson("https://api.linear.app/graphql", { method: "POST",
    headers: { authorization }, json: { query, variables } });
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  if (errors.length > 0) {
    throw new ProviderRequestError(400, `Linear: ${String((errors[0] as { message?: unknown }).message ?? "error").slice(0, 200)}`);
  }
  return (payload.data ?? {}) as Record<string, Record<string, unknown> | undefined>;
}

export const LINEAR_ACTIONS: Record<string, ConnectorAction> = {
  read_issue: {
    effect: "read",
    requires: ["apiKey|oauthToken"],
    parse(statement) {
      return ISSUE.test(statement.target) && Number(statement.target.split("-")[1]) > 0 && !statement.text.trim()
        ? { issue: statement.target.toUpperCase() }
        : "name one issue: @linear:read_issue:ENG-42";
    },
    async execute({ credentials }, input) {
      const data = await linear(linearAuthorization(credentials), `query($id: String!) {
        issue(id: $id) { id identifier url title description state { name }
          comments(first: 20, orderBy: createdAt) { nodes { body } pageInfo { hasNextPage } } }
      }`, { id: input.issue });
      const issue = data.issue;
      const comments = issue?.comments as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } | undefined;
      const state = issue?.state as { name?: unknown } | undefined;
      if (!issue || typeof issue.id !== "string" || !issue.id || issue.identifier !== input.issue ||
          typeof issue.title !== "string" || !(issue.description === null || typeof issue.description === "string") ||
          typeof state?.name !== "string" || !Array.isArray(comments?.nodes) || comments.nodes.length > 20 ||
          typeof comments.pageInfo?.hasNextPage !== "boolean" || comments.nodes.some(node =>
            !node || typeof node !== "object" || typeof (node as { body?: unknown }).body !== "string")) {
        throw new ProviderRequestError(502, "Linear did not confirm the requested issue and comment excerpt");
      }
      let url: URL;
      try { url = new URL(String(issue.url)); } catch {
        throw new ProviderRequestError(502, "Linear returned an invalid issue address");
      }
      if (url.origin !== "https://linear.app" || url.username || url.password ||
          !url.pathname.split("/").includes(input.issue!)) {
        throw new ProviderRequestError(502, "Linear returned an unexpected issue address");
      }
      url.search = "";
      url.hash = "";
      const text = `Issue: ${input.issue}\nTitle: ${issue.title}\nState: ${state.name}\n` +
        `Description:\n${issue.description ?? ""}\nComments (first provider page, up to 20):\n` +
        comments.nodes.map((node, index) => `${index + 1}. ${(node as { body: string }).body}`).join("\n");
      return { summary: taskContextExcerpt("Linear", text, comments.pageInfo.hasNextPage), url: url.href };
    },
  },
  comment: {
    effect: "write",
    requires: ["apiKey|oauthToken"],
    parse(statement) {
      return parseIssueComment(statement, ISSUE, "@linear:comment:ENG-42 <text>");
    },
    async execute({ credentials }, input) {
      const data = await linear(linearAuthorization(credentials), `mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success comment { url } } }`,
      { issueId: input.issue, body: input.text });
      const comment = data.commentCreate?.comment as { url?: string } | undefined;
      return { summary: `Commented on ${input.issue}`, ...(comment?.url ? { url: comment.url } : {}) };
    },
  },
  create_issue: {
    effect: "write",
    requires: ["apiKey|oauthToken"],
    parse(statement) {
      if (!TEAM.test(statement.target)) return "name a team key: @linear:create_issue:ENG <title>\\n<description>";
      const text = requireText(statement);
      if (!text) return "write the title after the team key";
      const { title, body } = titleAndBody(text);
      return { team: statement.target.toUpperCase(), title, body };
    },
    async execute({ credentials }, input) {
      const teams = await linear(linearAuthorization(credentials), `query($key: String!) {
        teams(filter: { key: { eq: $key } }) { nodes { id } } }`, { key: input.team });
      const teamId = ((teams.teams?.nodes as { id?: string }[] | undefined) ?? [])[0]?.id;
      if (!teamId) throw new ProviderRequestError(404, `Linear team ${input.team} was not found`);
      const data = await linear(linearAuthorization(credentials), `mutation($teamId: String!, $title: String!, $description: String) {
        issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
          success issue { identifier url } } }`, { teamId, title: input.title, description: input.body || null });
      const issue = data.issueCreate?.issue as { identifier?: string; url?: string } | undefined;
      return { summary: `Created ${issue?.identifier ?? "an issue"}: ${input.title}`, ...(issue?.url ? { url: issue.url } : {}) };
    },
  },
};


/** Select only an opaque viewer id; account profile data is never persisted by Check. */
export async function verifyLinear(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (!credentials.oauthToken && !credentials.apiKey) return;
  const data = await linear(linearAuthorization(credentials), "query { viewer { id } }", {});
  if (typeof data.viewer?.id !== "string" || !data.viewer.id) {
    throw new ProviderRequestError(401, "Linear did not authenticate the API credential");
  }
}
