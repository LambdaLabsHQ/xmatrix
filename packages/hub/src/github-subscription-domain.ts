import { plainRecord } from "@xmatrix/protocol";
import {
  GITHUB_DEFAULT_REPOSITORY_FEATURES,
  GITHUB_REPOSITORY_FEATURES,
  githubRequiredCapabilities,
  type GitHubRepositoryFeature,
} from "@xmatrix/protocol";

export { GITHUB_REPOSITORY_FEATURES, githubRequiredCapabilities };
export type { GitHubRepositoryFeature };

export function record(value: unknown): Record<string, unknown> {
  return plainRecord(value) ?? {};
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** A repository counts as public only when GitHub says so; private, internal or unstated is not. */
export function githubRepositoryIsPublic(repository: unknown): boolean {
  const value = record(repository);
  const visibility = text(value.visibility).toLowerCase();
  return value.private === false && (visibility === "" || visibility === "public");
}

export interface GitHubWebhookRepositoryIdentity {
  owner: string;
  repo: string;
  sourceRef: string;
  url: string;
}

export function githubWebhookRepositoryIdentity(
  payload: Record<string, unknown>,
): GitHubWebhookRepositoryIdentity | undefined {
  const repository = record(payload.repository);
  const ownerObject = record(repository.owner);
  const owner = text(ownerObject.login) || text(ownerObject.name);
  const repo = text(repository.name);
  if (!owner || !repo) return undefined;
  return {
    owner,
    repo,
    sourceRef: `github:repo:${owner}/${repo}`.toLowerCase(),
    url: text(repository.html_url) || `https://github.com/${owner}/${repo}`,
  };
}

/**
 * `except:<login>` after a subscription's target names a GitHub account whose
 * activity it leaves out: issues and pull requests that account opened, and
 * any other event it caused. It is stored beside the features.
 */
const GITHUB_EXCEPT_PREFIX = "except:";
const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})(?:\[bot\])?$/u;

export interface GitHubSubscriptionSelection {
  features: GitHubRepositoryFeature[];
  /** Lowercase GitHub logins the subscription leaves out. */
  exceptions: string[];
}

function githubException(token: string): string | undefined {
  const normalized = token.trim().toLowerCase().replace(/^except:@?/u, GITHUB_EXCEPT_PREFIX);
  if (!normalized.startsWith(GITHUB_EXCEPT_PREFIX)) return undefined;
  const login = normalized.slice(GITHUB_EXCEPT_PREFIX.length);
  return GITHUB_LOGIN.test(login) ? login : undefined;
}

/** The features and excepted accounts a subscribe or unsubscribe command names. */
export function githubSubscriptionSelectionFromCommand(body: string): GitHubSubscriptionSelection {
  const match = body.match(
    /(?:^|\s)[@＠][\u200B-\u200D\uFEFF]*github:(?:subscribe|unsubscribe):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b([\s\S]*)$/iu,
  );
  const features: GitHubRepositoryFeature[] = [];
  const exceptions: string[] = [];
  for (const token of (match?.[1] || "").split(/[\s,]+/u)) {
    const normalized = token.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized === "all") {
      features.push(...GITHUB_REPOSITORY_FEATURES);
      continue;
    }
    const exception = githubException(normalized);
    if (exception) {
      exceptions.push(exception);
      continue;
    }
    if (!(GITHUB_REPOSITORY_FEATURES as readonly string[]).includes(normalized)) break;
    features.push(normalized as GitHubRepositoryFeature);
  }
  return {
    // Naming only exceptions changes them and leaves the features as they are.
    features: features.length > 0 ? [...new Set(features)]
      : exceptions.length > 0 ? [] : [...GITHUB_DEFAULT_REPOSITORY_FEATURES],
    exceptions: [...new Set(exceptions)].sort(),
  };
}

export function githubRepositoryFeaturesFromCommand(body: string): GitHubRepositoryFeature[] {
  return githubSubscriptionSelectionFromCommand(body).features;
}

/** The excepted logins a stored relation's features carry. */
export function githubSubscriptionExceptions(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((value) => typeof value === "string" ? [githubException(value)] : [])
    .filter((value): value is string => value !== undefined);
}

/**
 * A relation's next stored features: its kinds of event, then an
 * `except:<login>` entry per excepted account. A relation left with no kind
 * of event is empty, whatever it excepted.
 */
export function nextGitHubRepositoryFeatures(
  current: unknown,
  requested: GitHubRepositoryFeature[],
  action: "subscribe" | "unsubscribe",
  requestedExceptions: readonly string[] = [],
): string[] {
  const existing = new Set(
    Array.isArray(current)
      ? current.filter((value): value is GitHubRepositoryFeature =>
          typeof value === "string" &&
          (GITHUB_REPOSITORY_FEATURES as readonly string[]).includes(value))
      : [],
  );
  const exceptions = new Set(githubSubscriptionExceptions(current));
  for (const feature of requested) {
    if (action === "subscribe") existing.add(feature);
    else existing.delete(feature);
  }
  for (const login of requestedExceptions) {
    if (action === "subscribe") exceptions.add(login);
    else exceptions.delete(login);
  }
  const features = GITHUB_REPOSITORY_FEATURES.filter((feature) => existing.has(feature));
  if (features.length === 0) return [];
  return [...features, ...[...exceptions].sort().map((login) => `${GITHUB_EXCEPT_PREFIX}${login}`)];
}

/**
 * Whether a subscription that excepts these logins leaves this delivery out:
 * an issue or pull request event (comments and reviews included) by the
 * subject's opener, any other event by its sender.
 */
export function githubDeliveryExcepted(payload: Record<string, unknown>, exceptions: readonly string[]): boolean {
  if (exceptions.length === 0) return false;
  const pull = record(payload.pull_request);
  const subject = Object.keys(pull).length > 0 ? pull : record(payload.issue);
  const actor = Object.keys(subject).length > 0
    ? text(record(subject.user).login)
    : text(record(payload.sender).login);
  return actor !== "" && exceptions.includes(actor.toLowerCase());
}

export function githubFeatureForWebhookEvent(
  event: string,
  payload: Record<string, unknown>,
): GitHubRepositoryFeature | undefined {
  if (event === "push") return "commits";
  if (event === "issues") return "issues";
  if (event === "pull_request") return "pulls";
  if (event === "issue_comment" || event === "pull_request_review_comment") return "comments";
  if (event === "pull_request_review") return "reviews";
  if (event === "check_run" || event === "check_suite") return "checks";
  if (event === "release") return "releases";
  if (event === "code_scanning_alert") return "code-scanning";
  if (["status", "workflow_run", "deployment", "deployment_status"].includes(event)) return "status";
  if (event === "create" || event === "delete") {
    return text(payload.ref_type) === "repository" ? undefined : "commits";
  }
  return undefined;
}

function issueLine(
  event: string,
  payload: Record<string, unknown>,
  repository: { owner: string; repo: string },
): string {
  const issue = record(payload.issue);
  const pull = record(payload.pull_request);
  const subject = Object.keys(pull).length > 0 ? pull : issue;
  const number = text(subject.number);
  const title = text(subject.title) || `${repository.owner}/${repository.repo}${number ? `#${number}` : ""}`;
  const url = text(subject.html_url) || `https://github.com/${repository.owner}/${repository.repo}`;
  const action = text(payload.action) || "updated";
  const sender = text(record(payload.sender).login) || "GitHub";
  const body = text(record(payload.comment).body) || text(record(payload.review).body);
  const kind = Object.keys(pull).length > 0 || event.startsWith("pull_request")
    ? "pull request"
    : "issue";
  return [
    `${sender} ${action} ${kind} [${repository.owner}/${repository.repo}${number ? `#${number}` : ""}](${url}): ${title}`,
    body || undefined,
  ].filter(Boolean).join("\n\n");
}

function pushLine(payload: Record<string, unknown>, repository: {
  owner: string; repo: string; url: string;
}): string {
  const sender = text(record(payload.pusher).name) || text(record(payload.sender).login) || repository.owner;
  const ref = text(payload.ref).replace(/^refs\/(?:heads|tags)\//u, "") || "repository";
  const commits = Array.isArray(payload.commits) ? payload.commits.slice(0, 8).map(record) : [];
  const count = Number(payload.distinct_size ?? payload.size);
  const total = Number.isSafeInteger(count) && count >= 0 ? count : commits.length;
  const compare = text(payload.compare);
  const lines = [
    `${sender} pushed ${total} ${total === 1 ? "commit" : "commits"} to ${compare ? `[${ref}](${compare})` : ref} in [${repository.owner}/${repository.repo}](${repository.url})`,
  ];
  for (const commit of commits) {
    const id = text(commit.id) || text(commit.sha) || "unknown";
    const message = (text(commit.message) || "Commit").split(/\r?\n/u, 1)[0]!.slice(0, 300);
    const url = text(commit.url);
    lines.push(`- ${url ? `[${id.slice(0, 7)}](${url})` : id.slice(0, 7)} ${message}`);
  }
  if (total > commits.length) lines.push(`- ... ${total - commits.length} more commits omitted`);
  return lines.join("\n");
}

function operationalLine(
  event: string,
  payload: Record<string, unknown>,
  repository: { owner: string; repo: string; url: string },
): string {
  const eventObject = record(
    event === "check_run" ? payload.check_run
      : event === "check_suite" ? payload.check_suite
      : event === "workflow_run" ? payload.workflow_run
      : event === "deployment_status" ? payload.deployment_status
      : event === "deployment" ? payload.deployment
      : event === "release" ? payload.release
      : payload,
  );
  const name = text(eventObject.name) || text(eventObject.context) || text(eventObject.tag_name) ||
    event.replace(/_/gu, " ");
  const state = text(eventObject.conclusion) || text(eventObject.state) || text(eventObject.status) ||
    text(payload.action) || "updated";
  const url = text(eventObject.html_url) || text(eventObject.target_url) || text(eventObject.environment_url);
  return `GitHub ${event.replace(/_/gu, " ")} ${name} in [${repository.owner}/${repository.repo}](${repository.url}): ${state}${url ? ` ([details](${url}))` : ""}.`;
}

export function githubWebhookMessageBody(
  event: string,
  payload: Record<string, unknown>,
  repository: { owner: string; repo: string; url: string },
): string {
  if (event === "code_scanning_alert") {
    const number = record(payload.alert).number;
    const action = text(payload.action);
    if (!Number.isSafeInteger(number) || Number(number) < 1 || ![
      "created", "reopened", "reopened_by_user", "appeared_in_branch", "fixed", "closed_by_user",
    ].includes(action)) return "";
    // The alert reference is enough to retrieve its details with the reader's
    // own grant; SARIF messages, rule text and source snippets stay on GitHub.
    const url = `${repository.url}/security/code-scanning/${number}`;
    return `GitHub code scanning alert [${repository.owner}/${repository.repo}#${number}](${url}): ${action}.`;
  }
  if (event === "push") return pushLine(payload, repository);
  if (["issues", "pull_request", "issue_comment", "pull_request_review",
    "pull_request_review_comment"].includes(event)) {
    return issueLine(event, payload, repository);
  }
  return operationalLine(event, payload, repository);
}
