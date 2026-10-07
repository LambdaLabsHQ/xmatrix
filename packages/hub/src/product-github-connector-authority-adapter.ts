import { plainRecord } from "@xmatrix/protocol";
import type { ChannelAppMention, ChannelMessage } from "@xmatrix/protocol";
import {
  executeAppConnectorProviderAction,
  getAppConnectorProvider,
  type AppConnectorConnectionView,
} from "./app-connectors";
import type { Env } from "./types";
import { appCommand, listAppConnections, listAppSourceRelations } from "./apps";
import { getChannel } from "./spaces";
import { channelActionRefusal } from "./connectors/connector-commands";
import { publishCommandStatus } from "./connectors/command-support";
import {
  githubRepositoryFeaturesFromCommand,
  githubRequiredCapabilities,
  nextGitHubRepositoryFeatures,
} from "./github-subscription-domain";

interface ProductGitHubConnectorInput {
  env: Env;
  channelId: string;
  messageId: string;
  body: string;
  actorUserId: string;
}

/**
 * One statement of a message, with the per-statement identity every Authority
 * write is keyed on. Without it a two-statement message would derive the same
 * execution and command ids twice and the second write would be deduplicated
 * away as a retry of the first.
 */
interface ProductGitHubConnectorStatement extends ProductGitHubConnectorInput {
  /** `""` for the first statement, `:s<n>` after it. */
  statementKey: string;
  /** Collects this statement's status line; the message posts one combined. */
  status: (line: string) => void;
}

type ProductGitHubAction =
  | "subscribe"
  | "unsubscribe"
  | "merge"
  | "rerun_failed_jobs"
  | "dispatch_workflow"
  | "comment"
  | "create_issue"
  | "close_issue"
  | "reopen_issue"
  | "review";

const PRODUCT_GITHUB_ACTION_LABELS: Record<ProductGitHubAction, string> = {
  subscribe: "Subscribe repository",
  unsubscribe: "Unsubscribe repository",
  merge: "Merge pull request",
  rerun_failed_jobs: "Rerun failed workflow jobs",
  dispatch_workflow: "Dispatch workflow",
  comment: "Comment on issue or PR",
  create_issue: "Create issue",
  close_issue: "Close issue or PR",
  reopen_issue: "Reopen issue or PR",
  review: "Review pull request",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return plainRecord(value);
}

function connectionView(value: unknown): (AppConnectorConnectionView & Record<string, unknown>) | undefined {
  const candidate = record(value);
  if (!candidate || typeof candidate.id !== "string" || candidate.providerId !== "github" ||
      typeof candidate.providerName !== "string" ||
      !["configured", "disconnected", "error"].includes(String(candidate.status))) return undefined;
  return candidate as AppConnectorConnectionView & Record<string, unknown>;
}


function sourceRef(owner: string, repo: string): string {
  return `github:repo:${owner}/${repo}`.toLowerCase();
}

function leadingGitHubMention(body: string): ChannelAppMention | undefined {
  const trimmed = body.trim().replace(/^[\u200B-\u200D\uFEFF]*/u, "");
  const match = trimmed.match(
    /^[@＠][\u200B-\u200D\uFEFF]*(github)(?::([A-Za-z0-9._-]+))?(?::\S*)?(?:\s+|$)/iu,
  );
  if (!match) return undefined;
  const provider = getAppConnectorProvider("github");
  if (!provider) return undefined;
  const actionId = match[2]?.trim().toLowerCase() || "";
  const action = actionId
    ? provider.actions.find((candidate) => candidate.id.toLowerCase() === actionId)
    : undefined;
  return {
    token: `@github${actionId ? `:${actionId}` : ""}`,
    appId: provider.id,
    appName: provider.name,
    status: provider.status,
    actionId: actionId || undefined,
    actionLabel: action?.label,
  };
}

/** Ceiling on one message so a pasted transcript cannot become a command storm. */
const GITHUB_CONNECTOR_STATEMENT_LIMIT = 8;

/**
 * The connector statements one message carries, one per line.
 *
 * The leading line still has to be a GitHub mention: that is what makes this a
 * connector command rather than prose that happens to name one, and relaxing it
 * would let a quoted command inside a human's sentence execute.
 */
function gitHubConnectorStatements(body: string): string[] {
  const lines = body.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!lines[0] || !leadingGitHubMention(lines[0])) return [];
  return lines
    .filter((line) => leadingGitHubMention(line) !== undefined)
    .slice(0, GITHUB_CONNECTOR_STATEMENT_LIMIT);
}

export async function dispatchProductGitHubConnectorAfterAuthorityMessage(
  input: ProductGitHubConnectorInput,
): Promise<void> {
  const statements = gitHubConnectorStatements(input.body);
  /* The receipt is posted as the provider, never as the Human who authorized
     it, so its author comes from the mention rather than from `actorUserId`. */
  const appId = leadingGitHubMention(statements[0] || "")?.appId;
  if (!appId) return;
  const lines: string[] = [];
  /* Sequentially: statements about one repository read the relation they each
     rewrite, so running them together would let the second overwrite the first
     from a snapshot taken before it. */
  for (const [index, statement] of statements.entries()) {
    await runGitHubConnectorStatement({
      ...input,
      body: statement,
      statementKey: index === 0 ? "" : `:s${index}`,
      status: (line) => lines.push(line),
    });
  }
  /* One message in, one receipt out: every statement contributes a line rather
     than its own channel message. */
  await publishCommandStatus(getAppConnectorProvider(appId)!, input, lines);
}

async function runGitHubConnectorStatement(
  input: ProductGitHubConnectorStatement,
): Promise<void> {
  const mention = leadingGitHubMention(input.body);
  const actionId = mention?.actionId || "subscribe";
  if (!mention || mention.appId !== "github" || !(actionId in PRODUCT_GITHUB_ACTION_LABELS)) return;
  const action = actionId as ProductGitHubAction;

  const principal = { kind: "user" as const, id: input.actorUserId };
  const channel = record((await getChannel(input.env, { channelId: input.channelId, principal })).channel);
  const spaceId = typeof channel?.spaceId === "string" ? channel.spaceId : "";
  if (!spaceId) throw new Error("GitHub connector Channel has no Space identity");

  const listed = await listAppConnections(input.env, { spaceId, channelId: input.channelId, actorUserId: input.actorUserId });
  const connection = listed.map(connectionView).find((candidate) => candidate?.providerId === "github");
  if (!connection || connection.status !== "configured") {
    input.status("GitHub subscription blocked; connect GitHub to this Space first.");
    return;
  }

  const executionId = `app-execution:${input.messageId}${input.statementKey}:github:${action}`.slice(0, 240);
  await appCommand(input.env, "record-execution", {
    commandId: `product:github-record:${input.messageId}${input.statementKey}:${action}`.slice(0, 200),
    executionId,
    connectionId: connection.id,
    channelId: input.channelId,
    messageId: input.messageId,
    actionId: action,
    actionLabel: PRODUCT_GITHUB_ACTION_LABELS[action],
    requestedByLabel: input.actorUserId,
    principal,
  });

  /* Every action but unsubscribe is the Channel's policy to decide
     (docs/design/connector-platform.md §3.5): a subscription brings the
     repository's content into the Channel. Unsubscribing only narrows it. */
  if (action !== "unsubscribe") {
    const refusal = await channelActionRefusal(input.env, { connectionId: connection.id,
      channelId: input.channelId, actionId: action });
    if (refusal) {
      await finalizeExecution(executionId, input, "blocked", refusal.slice(0, 500));
      input.status(`GitHub ${action}: blocked; ${refusal}.`);
      return;
    }
  }

  const result = await executeAppConnectorProviderAction({
    env: input.env,
    mention,
    message: { messageId: input.messageId, channelId: input.channelId, body: input.body } as ChannelMessage,
    connection,
  });
  if (result.type === "terminal") {
    await finalizeExecution(executionId, input, result.status, result.reason);
    input.status(`GitHub ${action}: ${result.status}; ${result.reason.replace(/_/gu, " ")}.`);
    return;
  }
  if (action === "merge") {
    if (result.type !== "github_pull_request_merged") {
      await finalizeExecution(executionId, input, "failed", "pull_request_merge_required");
      input.status("GitHub merge: failed; pull request merge required.");
      return;
    }
    const summary = `Merged ${result.issue.ref.owner}/${result.issue.ref.repo}#${result.issue.ref.issueNumber}`;
    await finalizeExecution(executionId, input, "completed", undefined, summary);
    input.status(`GitHub merge: completed; ${summary}.`);
    return;
  }
  const written = githubWriteSummary(result);
  if (written) {
    await finalizeExecution(executionId, input, "completed", undefined, written);
    input.status(`GitHub ${action}: completed; ${written}.`);
    return;
  }
  if (action === "rerun_failed_jobs") {
    if (result.type !== "github_actions_failed_jobs_rerun") {
      await finalizeExecution(executionId, input, "failed", "actions_rerun_required");
      input.status("GitHub rerun failed jobs: failed; Actions rerun required.");
      return;
    }
    const repository = `${result.repository.owner}/${result.repository.repo}`;
    const summary = `Requested failed-job rerun for ${repository} Actions run ${result.runId}`;
    await finalizeExecution(executionId, input, "completed", undefined, summary);
    input.status(`GitHub rerun failed jobs: completed; ${summary}.`);
    return;
  }
  if (action === "dispatch_workflow") {
    if (result.type !== "github_workflow_dispatched") {
      await finalizeExecution(executionId, input, "failed", "workflow_dispatch_required");
      input.status("GitHub dispatch workflow: failed; workflow dispatch required.");
      return;
    }
    const repository = `${result.repository.owner}/${result.repository.repo}`;
    const summary = `Dispatched ${repository}/${result.workflowId} at ${result.ref}`;
    await finalizeExecution(executionId, input, "completed", undefined, summary);
    input.status(`GitHub dispatch workflow: completed; ${summary}.`);
    return;
  }
  if (action !== "subscribe" && action !== "unsubscribe") {
    await finalizeExecution(executionId, input, "failed", "unexpected_provider_result");
    input.status(`GitHub ${action}: failed; unexpected provider result.`);
    return;
  }
  if (result.type !== "github_subscribe_repository" && result.type !== "github_unsubscribe_repository") {
    await finalizeExecution(executionId, input, "failed", "repository_subscription_required");
    input.status(`GitHub ${action}: failed; repository subscription required.`);
    return;
  }

  const requestedFeatures = githubRepositoryFeaturesFromCommand(input.body);
  const capabilities = new Set([
    ...result.capabilities,
    ...(connection.capabilities || []),
  ]);
  const missing = action === "subscribe"
    ? githubRequiredCapabilities(requestedFeatures).filter((capability) => !capabilities.has(capability))
    : [];
  if (missing.length > 0) {
    const reason = `missing_capabilities:${missing.join(",")}`;
    await finalizeExecution(executionId, input, "blocked", reason);
    input.status(`GitHub ${action}: blocked; ${reason}.`);
    return;
  }

  const repositorySource = sourceRef(result.repository.owner, result.repository.repo);
  const relations = await listAppSourceRelations(input.env, { channelId: input.channelId, principal });
  const currentRelation = relations.map(record).find((candidate) =>
    candidate?.connectionId === connection.id && candidate?.kind === "repository" &&
    candidate?.source === repositorySource,
  );
  const nextFeatures = nextGitHubRepositoryFeatures(
    currentRelation?.features,
    requestedFeatures,
    action,
  );
  if (nextFeatures.length > 0) {
    await appCommand(input.env, "put-relation", {
      commandId: `product:github-relation:${input.messageId}${input.statementKey}:put`.slice(0, 200),
      connectionId: connection.id,
      channelId: input.channelId,
      sourceKind: "repository",
      sourceRef: repositorySource,
      features: nextFeatures,
      principal,
    });
  } else {
    if (typeof currentRelation?.id === "string") {
      await appCommand(input.env, "remove-relation", {
        commandId: `product:github-relation:${input.messageId}${input.statementKey}:remove`.slice(0, 200),
        relationId: currentRelation.id,
        principal,
      });
    }
  }

  const repositoryName = `${result.repository.owner}/${result.repository.repo}`;
  const summary = action === "subscribe"
    ? `Subscribed to ${repositoryName} (${nextFeatures.join(", ")})`
    : nextFeatures.length > 0
      ? `Updated ${repositoryName} subscription (${nextFeatures.join(", ")})`
      : `Unsubscribed from ${repositoryName}`;
  await finalizeExecution(executionId, input, "completed", undefined, summary);
  input.status(`GitHub ${action}: completed; ${summary}.`);
}

/* The receipt for the issue and pull request writes, whose results carry the issue they changed. */
function githubWriteSummary(result: Awaited<ReturnType<typeof executeAppConnectorProviderAction>>): string | undefined {
  if (!("issue" in result)) return undefined;
  const ref = `${result.issue.ref.owner}/${result.issue.ref.repo}#${result.issue.ref.issueNumber}`;
  if (result.type === "github_comment_created") return `Commented on ${ref}`;
  if (result.type === "github_issue_created") return `Created ${ref}: ${result.issue.title.slice(0, 120)}`;
  if (result.type === "github_issue_state_changed") return `${ref} is ${result.issue.state}`;
  if (result.type === "github_pull_request_review_submitted") {
    return `Reviewed ${ref}${result.review.state ? ` (${result.review.state.toLowerCase()})` : ""}`;
  }
  return undefined;
}

async function finalizeExecution(
  executionId: string,
  input: ProductGitHubConnectorStatement,
  status: string,
  reason?: string,
  resultSummary?: string,
): Promise<void> {
  await appCommand(input.env, "finalize-execution", {
    commandId: `product:github-finalize:${input.messageId}${input.statementKey}:${status}`.slice(0, 200),
    executionId,
    expectedVersion: 1,
    status,
    ...(reason ? { reason } : {}),
    ...(resultSummary ? { resultSummary, resultChannelId: input.channelId } : {}),
    principal: { kind: "user", id: input.actorUserId },
  });
}
