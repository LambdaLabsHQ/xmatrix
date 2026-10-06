import { PostgresPageRepository } from "@xmatrix/db";
import {
  publishGitHubCheckRun, readGitHubPullRequestForReview, readGitHubPullRequestHead,
  type AppConnectorConnectionView, type GitHubPullRequestForReview,
} from "./app-connectors";
import { appOrigin } from "./deployment-origins";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { deterministicConversationId, launchConversationAgent, openConversation } from "./system-conversation";
import type { Env } from "./types";
import { findAppConnection } from "./apps";
import { runtimeRepository } from "./runtime";
import { getChannel } from "./spaces";

/**
 * Pre-review (docs/design/pages-and-conversations.md §5.6): a claimed pull
 * request gets its own review conversation on the block it works on, and an
 * Agent of the Space owner's reviews it there before any maintainer does. The
 * Agent's verdict is the `xmatrix/pre-review` check.
 */
export const PRE_REVIEW_CHECK_NAME = "xmatrix/pre-review";

export interface PullRequestRef { url: string; owner: string; repo: string; number: number }

/** The pull request a review conversation is about, from its metadata. */
export function reviewedPullRequest(metadata: unknown): (PullRequestRef & { pageId: string; blockId: string }) | null {
  const value = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).pullRequest : null;
  if (!value || typeof value !== "object") return null;
  const pull = value as Record<string, unknown>;
  const [owner, repo] = typeof pull.repository === "string" ? pull.repository.split("/") : [];
  return typeof pull.url === "string" && owner && repo && typeof pull.number === "number" &&
    typeof pull.pageId === "string" && typeof pull.blockId === "string"
    ? { url: pull.url, owner, repo, number: pull.number, pageId: pull.pageId, blockId: pull.blockId }
    : null;
}

export function preReviewPrompt(input: {
  pull: GitHubPullRequestForReview; url: string; blockLink: string; pageId: string; blockId: string;
  holder: string;
}): string {
  const { pull } = input;
  const files = pull.files.map((file) =>
    `### ${file.filename} (${file.status}, +${file.additions} −${file.deletions})\n` +
    (file.patch ? "```diff\n" + file.patch + "\n```" : "(patch not shown)")).join("\n\n");
  const checks = pull.checks.length
    ? pull.checks.map((check) => `- ${check.name}: ${check.conclusion ?? check.status}`).join("\n")
    : "- (no checks reported yet)";
  const others = pull.openPullRequests.length
    ? pull.openPullRequests.map((other) => `- #${other.number} ${other.title} — ${other.url}`).join("\n")
    : "- (none)";
  return [
    `Pre-review pull request ${input.url} before a maintainer sees it.`,
    `It does the work ${input.holder} claimed on ${input.blockLink} ` +
      `(\`xmatrix page read ${input.pageId}${input.blockId ? ` --block ${input.blockId}` : ""}\`).`,
    "",
    "Check four things and nothing else:",
    "1. Scope: the change does what that block describes, and not more.",
    "2. Tests: the checks below pass, and the change is covered by tests where it should be.",
    "3. Duplicates: no other open pull request below already does this work.",
    "4. Governance: it follows the Space's governance page, if the page tree (`xmatrix page tree`) has one.",
    "",
    "Reply here with what you found, briefly, then record the verdict with " +
      "`xmatrix page pre-review --verdict pass -m \"<one line>\"` or `--verdict changes`.",
    "",
    `## ${pull.title}`,
    `by @${pull.author}, head ${pull.headSha}`,
    "",
    pull.body || "(no description)",
    "",
    "## Checks on the head commit",
    checks,
    "",
    "## Other open pull requests",
    others,
    "",
    "## Change",
    files,
  ].join("\n");
}

function pages(env: Env): PostgresPageRepository {
  return new PostgresPageRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-pre-review", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
}

/** Opens the pull request's review conversation on its block and launches the pre-review there. */
export async function startPreReview(env: Env, input: {
  spaceId: string; spaceOwnerUserId: string; connection: AppConnectorConnectionView; pull: PullRequestRef;
  pageId: string; blockId: string; restricted: boolean; holder: string; blockLink: string;
}): Promise<void> {
  const { spaceId, pull } = input;
  const principal = { kind: "user" as const, id: input.spaceOwnerUserId };
  const review = await readGitHubPullRequestForReview(env, input.connection, pull, pull.number);
  if (review.draft) return;
  // One review conversation per pull request in a Space.
  const channelId = await deterministicConversationId("pre-review", spaceId, pull.url);
  await openConversation(env, { spaceId, channelId, userId: input.spaceOwnerUserId,
    name: `Review ${pull.owner}/${pull.repo}#${pull.number}`, mode: input.restricted ? "closed" : "open",
    metadata: { createdBy: "github", pullRequest: { url: pull.url, repository: `${pull.owner}/${pull.repo}`,
      number: pull.number, pageId: input.pageId, blockId: input.blockId } } });
  await pages(env).link({ requestId: crypto.randomUUID(), spaceId, principal, conversationId: channelId,
    pageId: input.pageId, blockId: input.blockId, source: "reference" });
  await launchConversationAgent(env, input.spaceOwnerUserId, {
    channelId,
    commandId: `pre-review:${channelId}:${review.headSha}`.slice(0, 200),
    body: preReviewPrompt({ pull: review, url: pull.url, blockLink: input.blockLink, pageId: input.pageId,
      blockId: input.blockId, holder: input.holder }),
    runMetadata: { routedAs: "pull_request_pre_review", pullRequestUrl: pull.url, headSha: review.headSha },
  });
}

export class PreReviewError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

/**
 * The review conversation's verdict, published as `xmatrix/pre-review` on the
 * exact head commit the reviewing Run was launched to review, with the Space's
 * own installation. A verdict never moves to a different commit: when the pull
 * request's head has moved since the review started, nothing is published and
 * the new head waits for its own review.
 */
export async function publishPreReviewVerdict(env: Env, input: {
  channelId: string; actorUserId: string; runId: string; verdict: "pass" | "changes"; summary: string;
}): Promise<{ headSha: string }> {
  const principal = { kind: "user" as const, id: input.actorUserId };
  const channel = await getChannel(env, { channelId: input.channelId, principal }).catch(() => {
    throw new PreReviewError("channel_not_found", 404, "This conversation was not found");
  });
  const record = channel.channel as { spaceId?: string; metadata?: unknown };
  const pull = reviewedPullRequest(record.metadata);
  if (!pull || !record.spaceId) {
    throw new PreReviewError("not_a_review_conversation", 409, "This conversation is not a pull request's review");
  }
  const headSha = await reviewedHeadSha(env, input, pull.url);
  const connection = await findAppConnection(env, { spaceId: record.spaceId, providerId: "github",
    actorUserId: principal.id });
  if (!connection) throw new PreReviewError("github_connection_required", 409, "Connect GitHub for this Space");
  const currentSha = await readGitHubPullRequestHead(env, connection, pull, pull.number);
  if (currentSha !== headSha) {
    throw new PreReviewError("pre_review_head_moved", 409,
      `The pull request's head moved from ${headSha} to ${currentSha} during this review; ` +
      "the new head gets its own review");
  }
  const link = `${appOrigin(env)}/app?channel=${encodeURIComponent(input.channelId)}`;
  await publishGitHubCheckRun(env, connection, pull, {
    name: PRE_REVIEW_CHECK_NAME, headSha, detailsUrl: link,
    conclusion: input.verdict === "pass" ? "success" : "failure",
    title: input.verdict === "pass" ? "Pre-review passed" : "Pre-review asks for changes",
    summary: `${input.summary}\n\n[The review conversation](${link})`,
  });
  return { headSha };
}

/** The head commit this Run was launched to pre-review, as Hub recorded it at launch. */
async function reviewedHeadSha(env: Env, input: { runId: string; actorUserId: string }, pullUrl: string): Promise<string> {
  const result = await runtimeRepository(env).getRun({ requestId: crypto.randomUUID(), runId: input.runId,
    actorUserId: input.actorUserId }).catch(() => undefined);
  const run = result?.run as { metadata?: unknown } | undefined;
  const metadata = run?.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
    ? run.metadata as Record<string, unknown> : {};
  if (metadata.routedAs !== "pull_request_pre_review" || metadata.pullRequestUrl !== pullUrl ||
    typeof metadata.headSha !== "string" || !metadata.headSha) {
    throw new PreReviewError("pre_review_run_required", 403,
      "Only the Run launched to review this pull request records its verdict");
  }
  return metadata.headSha;
}
