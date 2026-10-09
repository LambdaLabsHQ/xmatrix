import { appCommand, findAppConnection } from "./apps";
import { githubConnectionInstallationFor, type GitHubCommitCheckVerdict } from "./app-connectors";
import { record, text, type GitHubRepositoryFeature } from "./github-subscription-domain";
import type { Env } from "./types";

/*
 * A pull request a Run opens is subscribed to the conversation it was opened
 * in (docs/design/conversation-activity.md §3.6). Its merge, its reviews and
 * comments, and one verdict per settled CI come back there as messages, so
 * the Agent that opened it can end its turn instead of watching GitHub, and is
 * woken when something happened. The subscription is an ordinary `issue`
 * source relation: the Channel's subscriptions list shows it, and it ends when
 * the pull request closes.
 */

export const PULL_REQUEST_SUBSCRIPTION_FEATURES: GitHubRepositoryFeature[] = ["pulls", "comments", "reviews", "checks"];

/** At most this many pull requests one check suite reports are followed. */
const MAX_EVENT_ISSUES = 5;

export function githubIssueSourceRef(repository: string, number: number): string {
  return `github:issue:${repository}#${number}`.toLowerCase();
}

function issueNumber(value: unknown): number | undefined {
  const number = Number(record(value).number);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** The issues and pull requests a webhook event is about. */
export function githubWebhookIssueNumbers(event: string, payload: Record<string, unknown>): number[] {
  if (event === "check_suite") {
    const pulls = record(payload.check_suite).pull_requests;
    const numbers = (Array.isArray(pulls) ? pulls : []).map(issueNumber)
      .filter((number): number is number => number !== undefined);
    return [...new Set(numbers)].slice(0, MAX_EVENT_ISSUES);
  }
  const number = issueNumber(event.startsWith("pull_request") ? payload.pull_request : payload.issue);
  return number === undefined ? [] : [number];
}

/**
 * Whether an issue subscription can be about the issue this event names.
 * Numbers are only unique within one repository's history: a subscription
 * made before the issue existed named an earlier issue with that number (the
 * repository's history was replaced since), and must not hear this one.
 */
export function githubIssueSubscriptionCurrent(event: string, payload: Record<string, unknown>,
  subscribedAt: string): boolean {
  const subject = record(event.startsWith("pull_request") ? payload.pull_request : payload.issue);
  const opened = Date.parse(text(subject.created_at));
  const subscribed = Date.parse(subscribedAt);
  return !Number.isFinite(opened) || !Number.isFinite(subscribed) || subscribed >= opened;
}

/** Whether this event closed the pull request, which ends its subscription. */
export function githubPullRequestClosed(event: string, payload: Record<string, unknown>): boolean {
  return event === "pull_request" && payload.action === "closed";
}

/** The check suite's commit, when the event is a suite that just finished. */
export function githubSettledCheckSuiteSha(event: string, payload: Record<string, unknown>): string | undefined {
  if (event !== "check_suite" || payload.action !== "completed") return undefined;
  return text(record(payload.check_suite).head_sha) || undefined;
}

function login(value: unknown): string {
  return text(record(value).login).toLowerCase();
}

/**
 * The message a subscribed pull request's event posts, or undefined for one
 * that says nothing new to its conversation: the author's own pushes, comments,
 * reviews and merge (the Agent that opened it did those itself), edits,
 * labels, and every check but the settled verdict.
 */
export function githubPullRequestEventMessage(input: {
  event: string;
  payload: Record<string, unknown>;
  repository: { owner: string; repo: string; url: string };
  number: number;
  verdict?: GitHubCommitCheckVerdict;
}): string | undefined {
  const { event, payload, repository, number } = input;
  const subject = record(event.startsWith("pull_request") ? payload.pull_request : payload.issue);
  const author = login(subject.user);
  const sender = login(payload.sender);
  const title = text(subject.title);
  const ref = `${repository.owner}/${repository.repo}#${number}`;
  const url = text(subject.html_url) || `${repository.url}/pull/${number}`;
  const link = `[${ref}](${url})`;
  const actor = text(record(payload.sender).login) || "GitHub";
  const own = author !== "" && sender === author;
  if (event === "pull_request") {
    if (payload.action !== "closed" || own) return undefined;
    return `${actor} ${subject.merged === true ? "merged" : "closed"} pull request ${link}${title ? `: ${title}` : ""}`;
  }
  if (event === "pull_request_review") {
    const review = record(payload.review);
    if (payload.action !== "submitted" || login(review.user) === author) return undefined;
    const state = text(review.state).toLowerCase().replace(/_/gu, " ") || "reviewed";
    const body = text(review.body);
    return [`${actor} ${state === "commented" ? "reviewed" : state} ${link}`, body || undefined]
      .filter(Boolean).join("\n\n");
  }
  if (event === "pull_request_review_comment" || event === "issue_comment") {
    const comment = record(payload.comment);
    if (payload.action !== "created" || login(comment.user) === author) return undefined;
    const path = text(comment.path);
    const at = text(comment.html_url);
    return [`${actor} commented on ${link}${path ? ` (${path})` : ""}${at ? ` ([comment](${at}))` : ""}`,
      text(comment.body) || undefined].filter(Boolean).join("\n\n");
  }
  if (event === "check_suite") {
    const verdict = input.verdict;
    if (!verdict || verdict.state === "pending") return undefined;
    const sha = text(record(payload.check_suite).head_sha).slice(0, 7);
    if (verdict.state === "passed") return `CI passed on ${link} at ${sha}.`;
    const failed = verdict.failed.slice(0, 10).map((check) => check.url ? `[${check.name}](${check.url})` : check.name);
    const more = verdict.failed.length > failed.length ? `, and ${verdict.failed.length - failed.length} more` : "";
    return `CI failed on ${link} at ${sha}: ${failed.join(", ")}${more}.`;
  }
  return undefined;
}

export interface PullRequestSubscriptionDependencies {
  findConnection: typeof findAppConnection;
  installationFor: typeof githubConnectionInstallationFor;
  command: typeof appCommand;
}

/**
 * Subscribe the conversation a Run opened a pull request in to it, as the
 * Run's owner. Only a pull request the Space's GitHub connection reaches can
 * be subscribed; any other is left alone.
 */
export async function subscribeConversationToPullRequest(env: Env, input: {
  spaceId: string; channelId: string; ownerUserId: string; repository: string; number: number; commandId: string;
}, dependencies: Partial<PullRequestSubscriptionDependencies> = {}): Promise<boolean> {
  const findConnection = dependencies.findConnection ?? findAppConnection;
  const installationFor = dependencies.installationFor ?? githubConnectionInstallationFor;
  const command = dependencies.command ?? appCommand;
  const [owner, repo] = input.repository.split("/");
  if (!owner || !repo) return false;
  const connection = await findConnection(env, { spaceId: input.spaceId, providerId: "github",
    actorUserId: input.ownerUserId });
  if (!connection || connection.status !== "configured") return false;
  try {
    await installationFor(env, connection, owner, repo);
  } catch {
    return false;
  }
  await command(env, "put-relation", {
    commandId: `product:github-pull-request:${input.commandId}`.slice(0, 200),
    connectionId: connection.id, channelId: input.channelId, sourceKind: "issue",
    sourceRef: githubIssueSourceRef(input.repository, input.number),
    features: PULL_REQUEST_SUBSCRIPTION_FEATURES,
    principal: { kind: "user", id: input.ownerUserId },
  });
  return true;
}
