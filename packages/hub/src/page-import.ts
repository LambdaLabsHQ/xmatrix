import { readGitHubRepositoryForImport, type GitHubRepositoryForImport } from "./app-connectors";
import { deterministicConversationId, launchConversationAgent, openConversation } from "./system-conversation";
import type { Env } from "./types";
import { findAppConnection } from "./apps";

/**
 * Import onboarding (docs/design/pages-and-conversations-migration.md §3,
 * "Starting from a repository"): a Space owner or admin picks a repository of
 * the Space's GitHub connection, and an Agent of theirs drafts the Space's
 * first page tree from it in an import conversation. The owner reviews and
 * applies the draft like any move to pages.
 */
export class PageImportError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

export function pageImportPrompt(source: GitHubRepositoryForImport): string {
  const issues = source.openIssues.length
    ? source.openIssues.map((issue) => `- ${issue.pullRequest ? "PR" : "Issue"} #${issue.number} ${issue.title}` +
        `${issue.labels.length ? ` [${issue.labels.join(", ")}]` : ""} — ${issue.url}` +
        `${issue.excerpt ? `\n  ${issue.excerpt.replace(/\s+/gu, " ")}` : ""}`).join("\n")
    : "- (none)";
  const documents = source.documents.map((document) => `### ${document.path}\n\n${document.text}`).join("\n\n");
  return [
    `Draft this Space's first page tree from the GitHub repository ${source.repository}.`,
    "",
    "Write pages as documents that say how the project stands now, not a copy of the files: what it is, " +
      "how it is built and run, its current state, goals and open work (grouped from the issues and pull " +
      "requests below), and how to contribute. Organize pages by what the project works on; merge, split " +
      "and drop freely; keep each page short. Link to files and issues instead of pasting them.",
    "Write JSON `{\"pages\": [{\"key\", \"parentKey\", \"title\", \"body\", \"sources\": []}]}` with parents " +
      "before children, submit it with `xmatrix page migration submit -f <file>` (`xmatrix page migration show` " +
      "shows what is there; pass `--replaces <version>` to replace a draft), and then tell the owner here that " +
      "the draft is ready to review in Pages.",
    "",
    `## ${source.repository}`,
    source.description || "(no description)",
    "",
    "## README",
    source.readme || "(no README)",
    "",
    "## Open issues and pull requests",
    issues,
    "",
    "## Documents",
    documents || "(no other markdown documents)",
  ].join("\n");
}

export async function startPageImport(env: Env, input: {
  spaceId: string; userId: string; repository: string;
}): Promise<{ conversationId: string }> {
  const [owner, repo] = input.repository.split("/");
  if (!owner || !repo || input.repository.split("/").length !== 2) {
    throw new PageImportError("invalid_request", 400, "repository is owner/name");
  }
  const connection = await findAppConnection(env, { spaceId: input.spaceId, providerId: "github",
    actorUserId: input.userId });
  if (!connection || connection.status !== "configured") {
    throw new PageImportError("github_connection_required", 409, "Connect GitHub for this Space first");
  }
  const source = await readGitHubRepositoryForImport(env, connection, { owner, repo });
  const conversationId = await deterministicConversationId("page-import", input.spaceId, source.repository);
  await openConversation(env, { spaceId: input.spaceId, channelId: conversationId,
    name: `Import ${source.repository}`, mode: "open", metadata: { createdBy: "page-import" }, userId: input.userId });
  await launchConversationAgent(env, input.userId, {
    channelId: conversationId,
    commandId: `page-import:${conversationId}:${crypto.randomUUID()}`,
    body: pageImportPrompt(source),
    runMetadata: { routedAs: "page_import", repository: source.repository },
  });
  return { conversationId };
}
