import { ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { linear, linearRecord, LINEAR_ISSUE, LINEAR_ID } from "./linear-api";
import { LINEAR_MUTATION_ACTIONS } from "./linear-mutations";
import { LINEAR_RESOURCE_ACTIONS, LINEAR_ISSUE_FIELDS } from "./linear-resources";
import { taskContextExcerpt } from "./task-context";

export const LINEAR_ACTIONS: Record<string, ConnectorAction> = {
  ...LINEAR_RESOURCE_ACTIONS,
  ...LINEAR_MUTATION_ACTIONS,
  read_issue: {
    effect: "read",
    requires: ["apiKey|oauthToken"],
    parse(statement) {
      return (LINEAR_ISSUE.test(statement.target) || LINEAR_ID.test(statement.target)) && !statement.text.trim()
        ? { issue: LINEAR_ID.test(statement.target) ? statement.target.toLowerCase() : statement.target.toUpperCase() }
        : "name one issue identifier or UUID: @linear:read_issue:ENG-42";
    },
    async execute({ credentials }, input) {
      const data = await linear(credentials, `query($id: String!) {
        issue(id: $id) { ${LINEAR_ISSUE_FIELDS} description
          comments(first: 20, orderBy: createdAt) { nodes { body } pageInfo { hasNextPage } } }
      }`, { id: input.issue });
      const issue = linearRecord(data.issue);
      const comments = issue?.comments as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } | undefined;
      const state = issue?.state as { name?: unknown } | undefined;
      if (!issue || typeof issue.id !== "string" || !issue.id || !(LINEAR_ID.test(input.issue!) ? issue.id.toLowerCase() === input.issue!.toLowerCase() : issue.identifier === input.issue) ||
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
          !url.pathname.split("/").includes(String(issue.identifier))) {
        throw new ProviderRequestError(502, "Linear returned an unexpected issue address");
      }
      url.search = "";
      url.hash = "";
      const metadata: Record<string, unknown> = Object.fromEntries(
        ["priority", "estimate", "dueDate", "labelIds", "archivedAt"].map(key => [key, issue[key]]));
      for (const field of ["team", "assignee", "project", "cycle", "parent", "projectMilestone"]) {
        const value = linearRecord(issue[field]);
        metadata[field] = issue[field] === null ? null : Object.fromEntries(
          ["id", "name", "key", "number", "identifier"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
      }
      const text = `Issue: ${issue.identifier}\nTitle: ${issue.title}\nState: ${state.name}\n` +
        `Metadata: ${JSON.stringify(metadata)}\n` +
        `Description:\n${issue.description ?? ""}\nComments (first provider page, up to 20):\n` +
        comments.nodes.map((node, index) => `${index + 1}. ${(node as { body: string }).body}`).join("\n");
      return { summary: taskContextExcerpt("Linear", text, comments.pageInfo.hasNextPage), url: url.href };
    },
  },
};


/** Select only an opaque viewer id; account profile data is never persisted by Check. */
export async function verifyLinear(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (!credentials.oauthToken && !credentials.apiKey) return;
  const data = await linear(credentials, "query { viewer { id } }", {});
  if (typeof linearRecord(data.viewer).id !== "string" || !linearRecord(data.viewer).id) {
    throw new ProviderRequestError(401, "Linear did not authenticate the API credential");
  }
}
