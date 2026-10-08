import { ControlError } from "@xmatrix/db";
import { base64DecodeBytes } from "./relay-v2-primitives";
import {
  APP_CONNECTOR_PROVIDER_MANIFESTS,
  type AppConnectorCompletionDynamicSource,
  type AppConnectorCompletionOption,
  type AppConnectorExecutionStatus,
  type AppConnectorProviderManifest,
  type ChannelMessage,
  type ChannelAppMention,
  type LaunchTargetRepo,
  type PageGitHubFile,
} from "@xmatrix/protocol";
import { githubRepositoryIsPublic } from "./github-subscription-domain";
import type { Env } from "./types";
import { base64UrlEncodeValue } from "./relay-v2-primitives";

export type AppConnectorEnv = Pick<Env, "GITHUB_API_BASE_URL" | "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">;

export interface AppConnectorConnectionView {
  id: string;
  providerId: string;
  providerName: string;
  status: "configured" | "disconnected" | "error";
  scopes?: string[];
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  version?: number;
}

export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
  htmlUrl: string;
}

type GitHubInstallationRepository = {
  id: string;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  /** Last GitHub push, falling back to repository metadata update. */
  activityAtMs: number;
};

interface GitHubIssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
  htmlUrl: string;
}

interface GitHubInstallationAuth {
  token: string;
  capabilities: string[];
  expiresAt?: string;
  /** `owner/name` of each repository the token covers, when GitHub listed them. */
  repositories?: string[];
}

/** GitHub App permission levels, as the access_tokens request names them. */
type GitHubPermissionRequest = Record<string, "read" | "write">;

/**
 * What an Agent's Git work needs from its repository token: fetch and push
 * (`contents`) plus the metadata every token carries. Pull requests, issues,
 * Actions, workflows and secrets are deliberately absent: `gh` keeps using the
 * machine owner's own login, and a pushed change to `.github/workflows` is
 * refused rather than letting an Agent rewrite what CI runs with.
 */
const AGENT_GIT_TOKEN_PERMISSIONS: GitHubPermissionRequest = { contents: "write", metadata: "read" };
/** The same request for an installation that was only given read access. */
const AGENT_GIT_TOKEN_READ_PERMISSIONS: GitHubPermissionRequest = { contents: "read", metadata: "read" };

interface GitHubIssueFetchResult {
  issue: GitHubIssueSnapshot;
  capabilities: string[];
}

interface GitHubIssueCommentResult {
  issue: GitHubIssueSnapshot;
  capabilities: string[];
  comment: {
    author?: string;
    body?: string;
    htmlUrl?: string;
    createdAt?: string;
  };
}

interface GitHubIssueCreateResult {
  issue: GitHubIssueSnapshot;
  capabilities: string[];
}

interface GitHubIssueStateChangeResult {
  issue: GitHubIssueSnapshot;
  capabilities: string[];
}

interface GitHubPullRequestReviewResult {
  issue: GitHubIssueSnapshot;
  capabilities: string[];
  review: {
    author?: string;
    body?: string;
    htmlUrl?: string;
    submittedAt?: string;
    state?: string;
  };
}

interface GitHubPullRequestMergeResult {
  issue: GitHubIssueSnapshot;
  capabilities: string[];
  merge: {
    merged: boolean;
    sha?: string;
    message?: string;
    method?: "merge" | "squash" | "rebase";
  };
}

type GitHubWorkflowInputValue = string | number | boolean;

interface GitHubActionsRerunResult {
  repository: GitHubRepositoryRef;
  capabilities: string[];
  runId: number;
}

interface GitHubWorkflowDispatchResult {
  repository: GitHubRepositoryRef;
  capabilities: string[];
  workflowId: string;
  ref: string;
  inputs: Record<string, GitHubWorkflowInputValue>;
}

export interface GitHubIssueSnapshot {
  ref: GitHubIssueRef;
  kind: "issue" | "pull_request";
  title: string;
  state: string;
  author?: string;
  body?: string;
  htmlUrl: string;
  labels: string[];
  pullRequest?: {
    baseRef?: string;
    baseSha?: string;
    headRef?: string;
    headSha?: string;
    draft?: boolean;
    merged?: boolean;
    mergeable?: boolean;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
    commits?: number;
    files: Array<{
      filename: string;
      status?: string;
      additions?: number;
      deletions?: number;
      changes?: number;
      blobUrl?: string;
    }>;
  };
  comments: Array<{
    author?: string;
    body?: string;
    htmlUrl?: string;
    createdAt?: string;
  }>;
}

export type AppConnectorProviderExecutionResult =
  | {
      type: "github_issue_to_channel";
      issue: GitHubIssueSnapshot;
      capabilities: string[];
    }
  | {
      type: "github_issue_to_thread";
      issue: GitHubIssueSnapshot;
      capabilities: string[];
    }
  | {
      type: "github_subscribe_issue";
      issue: GitHubIssueSnapshot;
      capabilities: string[];
    }
  | {
      type: "github_unsubscribe_issue";
      issue: GitHubIssueSnapshot;
      capabilities: string[];
    }
  | {
      type: "github_subscribe_repository";
      repository: GitHubRepositoryRef;
      capabilities: string[];
    }
  | {
      type: "github_unsubscribe_repository";
      repository: GitHubRepositoryRef;
      capabilities: string[];
    }
  | {
      type: "github_comment_created";
      issue: GitHubIssueSnapshot;
      capabilities: string[];
      comment: GitHubIssueCommentResult["comment"];
    }
  | {
      type: "github_issue_created";
      issue: GitHubIssueSnapshot;
      capabilities: string[];
    }
  | {
      type: "github_issue_state_changed";
      issue: GitHubIssueSnapshot;
      capabilities: string[];
    }
  | {
      type: "github_pull_request_review_submitted";
      issue: GitHubIssueSnapshot;
      capabilities: string[];
      review: GitHubPullRequestReviewResult["review"];
    }
  | {
      type: "github_pull_request_merged";
      issue: GitHubIssueSnapshot;
      capabilities: string[];
      merge: GitHubPullRequestMergeResult["merge"];
    }
  | {
      type: "github_actions_failed_jobs_rerun";
      repository: GitHubRepositoryRef;
      capabilities: string[];
      runId: number;
    }
  | {
      type: "github_workflow_dispatched";
      repository: GitHubRepositoryRef;
      capabilities: string[];
      workflowId: string;
      ref: string;
      inputs: Record<string, GitHubWorkflowInputValue>;
    }
  | {
      type: "terminal";
      status: Exclude<AppConnectorExecutionStatus, "queued" | "completed">;
      reason: string;
    };

export interface AppConnectorProviderExecutionContext {
  env: AppConnectorEnv;
  mention: ChannelAppMention;
  message: ChannelMessage;
  connection: AppConnectorConnectionView;
}

const GITHUB_CONNECTOR_COMMENT_PAGE_SIZE = 100;
const GITHUB_CONNECTOR_COMMENT_PAGE_LIMIT = 20;
const GITHUB_CONNECTOR_REPOSITORY_PAGE_SIZE = 100;
const GITHUB_CONNECTOR_REPOSITORY_PAGE_LIMIT = 10;

const PROVIDERS_BY_ID = new Map(APP_CONNECTOR_PROVIDER_MANIFESTS.map((provider) => [provider.id, provider]));

export function getAppConnectorProvider(providerId: string): AppConnectorProviderManifest | undefined {
  return PROVIDERS_BY_ID.get(providerId.trim().toLowerCase() as AppConnectorProviderManifest["id"]);
}

/**
 * Resolve the immutable message presentation for a connector from the shared
 * provider manifest. Callers supply only the stable provider id so message
 * author labels and assets cannot drift across individual connector adapters.
 */
export function appConnectorMessageSenderSnapshot(providerId: string): Record<string, unknown> {
  const provider = getAppConnectorProvider(providerId);
  if (!provider) throw new TypeError("app connector message provider is unsupported");
  return {
    identityId: `app:${provider.id}`,
    kind: "app",
    label: provider.name,
    name: provider.name,
    userId: "",
    email: "",
    avatarUrl: `/app-connectors/${encodeURIComponent(provider.id)}.svg`,
  };
}

/**
 * Build the GitHub App install/configure URL.
 * - mode=add (or no target): GitHub account picker so another User/Org can be installed.
 * - mode=manage with installationId: deep-link that account via target_id.
 */
export async function buildGitHubAppInstallUrl(
  env: AppConnectorEnv,
  options: {
    appSlug: string;
    state: string;
    mode?: "add" | "manage" | "install";
    installationId?: string;
  }
): Promise<{ url: string; mode: "add" | "manage" | "install" }> {
  const appSlug = options.appSlug.trim();
  const state = options.state.trim();
  if (!appSlug || !state) {
    throw new Error("github_install_url_invalid");
  }

  const installUrl = new URL(`https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`);
  installUrl.searchParams.set("state", state);

  const requestedMode = options.mode === "manage" || options.mode === "add" || options.mode === "install"
    ? options.mode
    : options.installationId?.trim()
      ? "manage"
      : "install";
  const installationId = options.installationId?.trim();

  if (requestedMode === "manage" && installationId) {
    try {
      const targetId = await fetchGitHubInstallationTargetId(env, installationId);
      if (targetId) {
        installUrl.searchParams.set("target_id", targetId);
      }
    } catch {
      // Fall back to the generic install picker when installation lookup fails.
    }
    return { url: installUrl.toString(), mode: "manage" };
  }

  // add / install: no target_id so GitHub shows the account picker.
  return {
    url: installUrl.toString(),
    mode: requestedMode === "add" ? "add" : "install",
  };
}

/**
 * Canonical GitHub App installation ids for a space connection.
 * Reads bounded `metadata.installationIds: string[]` and legacy `metadata.installationId`.
 * Stable order: array order first, then legacy id if missing from the array.
 */
export function githubConnectionInstallationIds(
  connection: Pick<AppConnectorConnectionView, "metadata"> | { metadata?: Record<string, unknown> }
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const id = value.trim();
    if (!id || id.length > 80 || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  const list = connection.metadata?.installationIds;
  if (Array.isArray(list)) {
    for (const item of list) push(item);
  }
  push(connection.metadata?.installationId);
  return ids.slice(0, 32);
}

/**
 * Whether the GitHub user behind `userToken` can reach the App installation.
 * GitHub's setup redirect carries `installation_id` unsigned, so this is what
 * proves the installation is theirs before a Space may use it.
 */
/** The GitHub account one App installation belongs to, as Configure shows it. */
export interface GitHubInstallationAccount {
  installationId: string;
  login: string;
  type: string;
  avatarUrl?: string;
  repositorySelection?: string;
}

function githubInstallationAccount(value: unknown): GitHubInstallationAccount | undefined {
  const installation = githubObject(value);
  const id = githubNumber(installation.id);
  const account = githubObject(installation.account);
  const login = githubString(account.login) || githubString(account.slug) || githubString(account.name);
  if (typeof id !== "number" || !login) return undefined;
  const avatarUrl = githubString(account.avatar_url);
  const repositorySelection = githubString(installation.repository_selection);
  return {
    installationId: String(id),
    login: login.slice(0, 160),
    type: (githubString(account.type) || "User").slice(0, 40),
    ...(avatarUrl?.startsWith("https://") ? { avatarUrl } : {}),
    ...(repositorySelection ? { repositorySelection } : {}),
  };
}

/** The account of one installation, read as the App; undefined when GitHub no longer knows it. */
export async function describeGitHubInstallation(
  env: AppConnectorEnv,
  installationId: string
): Promise<GitHubInstallationAccount | undefined> {
  const jwt = await configuredGitHubAppJwt(env);
  const payload = await fetchGitHubJson(env, `/app/installations/${encodeURIComponent(installationId)}`, jwt)
    .catch(() => undefined);
  return payload ? githubInstallationAccount(payload) : undefined;
}

/** Every installation of this App that the user's GitHub account can reach. */
export async function listGitHubUserInstallations(
  env: AppConnectorEnv,
  userToken: string
): Promise<GitHubInstallationAccount[]> {
  const accounts: GitHubInstallationAccount[] = [];
  // Bounded: 10 pages of 100 covers every account that can install one App.
  for (let page = 1; page <= 10; page += 1) {
    const payload = await fetchGitHubJson(env, `/user/installations?per_page=100&page=${page}`, userToken) as
      { installations?: unknown[] };
    const installations = Array.isArray(payload?.installations) ? payload.installations : [];
    for (const installation of installations) {
      const account = githubInstallationAccount(installation);
      if (account) accounts.push(account);
    }
    if (installations.length < 100) break;
  }
  return accounts;
}

export function githubConnectionHasInstallation(
  connection: Pick<AppConnectorConnectionView, "metadata"> | { metadata?: Record<string, unknown> },
  installationId: string
): boolean {
  const needle = installationId.trim();
  if (!needle) return false;
  return githubConnectionInstallationIds(connection).includes(needle);
}

/**
 * The installation of this Space's GitHub connection that covers one
 * repository. A page's Automation triggered by that repository's events
 * records it, so only events from an installation the Space connected fire it.
 */
export async function githubConnectionInstallationFor(env: AppConnectorEnv,
  connection: Pick<AppConnectorConnectionView, "metadata">, owner: string, repo: string): Promise<string> {
  const installationId = await resolveGitHubRepositoryInstallationId(env, owner, repo);
  if (!githubConnectionHasInstallation(connection, installationId)) {
    throw new Error("github_installation_not_linked_to_space");
  }
  return installationId;
}

/** The paths a pull request changed (the first 300), read with one installation's token. */
export async function githubPullRequestPaths(env: AppConnectorEnv, installationId: string, owner: string,
  repo: string, number: number): Promise<string[]> {
  const auth = await githubInstallationAuthForId(env, installationId, { repositories: [repo] });
  const paths: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const files = await fetchGitHubJson(env, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${
      number}/files?per_page=100&page=${page}`, auth.token);
    if (!Array.isArray(files)) break;
    for (const file of files) {
      const path = githubString(githubObject(file).filename);
      if (path) paths.push(path);
    }
    if (files.length < 100) break;
  }
  return paths;
}

export interface GitHubRepositoryTokenGrant {
  token: string;
  expiresAt?: string;
  capabilities: string[];
  repository: { owner: string; repo: string };
}

/**
 * Mint a short-lived GitHub token for exactly one repository of this Space's
 * connector installation. This is the only credential a machine is given for
 * Git work, which is what keeps one machine's Spaces from reaching each other's
 * repositories: the machine never holds an account-wide GitHub login.
 */
export async function mintGitHubRepositoryToken(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  owner: string,
  repo: string
): Promise<GitHubRepositoryTokenGrant> {
  if (connection.providerId !== "github") {
    throw new Error("github_connection_required");
  }
  let auth: GitHubInstallationAuth;
  try {
    auth = await githubInstallationAuthForRepository(env, connection, owner, repo, AGENT_GIT_TOKEN_PERMISSIONS);
  } catch (error) {
    // GitHub answers 422 when a requested permission exceeds what the
    // installation holds. An installation given read-only contents still
    // serves fetches, so ask again for exactly that rather than failing.
    if (!(error instanceof Error) || error.message !== "github_api_422") throw error;
    auth = await githubInstallationAuthForRepository(env, connection, owner, repo, AGENT_GIT_TOKEN_READ_PERMISSIONS);
  }
  return {
    token: auth.token,
    expiresAt: auth.expiresAt,
    capabilities: auth.capabilities,
    repository: { owner, repo },
  };
}

export interface GitHubRepositoryForImport {
  repository: string;
  description: string;
  readme: string;
  documents: Array<{ path: string; text: string }>;
  openIssues: Array<{ number: number; title: string; url: string; pullRequest: boolean; labels: string[];
    excerpt: string }>;
}

const IMPORT_TEXT_BUDGET = 120_000;
const IMPORT_DOCUMENTS = 40;

function githubBase64(value: unknown): string {
  const encoded = typeof value === "string" ? value.replace(/\s/gu, "") : "";
  if (!encoded) return "";
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * What an import reads of a repository, with this Space's installation: its
 * README, its markdown documents within a budget, and its open issues and
 * pull requests.
 */
export async function readGitHubRepositoryForImport(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  repository: { owner: string; repo: string }
): Promise<GitHubRepositoryForImport> {
  const auth = await githubInstallationAuthWithCapability(env, connection, "github.contents.read", repository);
  const repoPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const repo = githubObject(await fetchGitHubJson(env, repoPath, auth.token));
  const branch = githubString(repo.default_branch) || "main";
  const [readme, tree, issues] = await Promise.all([
    fetchGitHubJson(env, `${repoPath}/readme`, auth.token).catch((error: unknown) => {
      if (error instanceof Error && error.message === "github_api_404") return {};
      throw error;
    }),
    fetchGitHubJson(env, `${repoPath}/git/trees/${encodeURIComponent(branch)}?recursive=1`, auth.token),
    fetchGitHubJson(env, `${repoPath}/issues?state=open&per_page=100`, auth.token),
  ]);
  let budget = IMPORT_TEXT_BUDGET;
  const take = (text: string) => {
    const kept = text.slice(0, Math.max(0, budget));
    budget -= kept.length;
    return kept;
  };
  const readmeText = take(githubBase64(githubObject(readme).content));
  const readmePath = githubString(githubObject(readme).path) || "";
  const paths = (Array.isArray(githubObject(tree).tree) ? githubObject(tree).tree as unknown[] : [])
    .map(githubObject)
    .filter((entry) => entry.type === "blob")
    .map((entry) => githubString(entry.path) || "")
    .filter((path) => /\.mdx?$/iu.test(path) && path !== readmePath && !/(^|\/)(node_modules|vendor|\.github)\//u.test(path))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, IMPORT_DOCUMENTS);
  const documents: GitHubRepositoryForImport["documents"] = [];
  for (const path of paths) {
    if (budget <= 0) break;
    const file = githubObject(await fetchGitHubJson(env,
      `${repoPath}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`,
      auth.token));
    documents.push({ path, text: take(githubBase64(file.content)) });
  }
  return {
    repository: `${repository.owner}/${repository.repo}`,
    description: githubString(repo.description) || "",
    readme: readmeText,
    documents,
    openIssues: (Array.isArray(issues) ? issues : []).map(githubObject).map((issue) => ({
      number: githubNumber(issue.number) ?? 0,
      title: githubString(issue.title) || "",
      url: githubString(issue.html_url) || "",
      pullRequest: Boolean(issue.pull_request),
      labels: (Array.isArray(issue.labels) ? issue.labels : []).map((label) => githubString(githubObject(label).name) || "")
        .filter(Boolean),
      excerpt: (githubString(issue.body) || "").slice(0, 300),
    })),
  };
}

/** What a page's embed shows of one repository file (docs/design/pages-live-document.md §6.5). */
export type GitHubFileContent = PageGitHubFile;

export class GitHubFileError extends ControlError {
  constructor(
    code: "github_repository_not_covered" | "github_file_not_found" | "github_file_not_a_file"
      | "github_read_failed",
    status: 403 | 404 | 422 | 502,
  ) {
    super(code, status, code);
  }
}

/** The most text an embed carries; a longer file is cut there and links to GitHub for the rest. */
export const GITHUB_FILE_TEXT_LIMIT = 256 * 1024;

/** The refusals that mean this Space's installation does not reach the repository, or cannot read its files. */
const GITHUB_REPOSITORY_NOT_COVERED = /^(?:github_installation_missing|github_repository_not_installed|github_installation_not_linked_to_space|missing_capabilities:.*)$/u;

/**
 * One file of a repository this Space's GitHub connection covers, read with a
 * token that can only read that repository's contents. Nothing is stored.
 */
export async function readGitHubFile(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  file: { owner: string; repo: string; path: string; ref: string | null }
): Promise<GitHubFileContent> {
  let auth: GitHubInstallationAuth;
  try {
    auth = await githubInstallationAuthWithCapability(env, connection, "github.contents.read",
      { owner: file.owner, repo: file.repo });
  } catch (error) {
    if (error instanceof Error && GITHUB_REPOSITORY_NOT_COVERED.test(error.message)) {
      throw new GitHubFileError("github_repository_not_covered", 403);
    }
    throw new GitHubFileError("github_read_failed", 502);
  }
  const contents = `/repos/${encodeURIComponent(file.owner)}/${encodeURIComponent(file.repo)}/contents/${
    file.path.split("/").map(encodeURIComponent).join("/")}${file.ref ? `?ref=${encodeURIComponent(file.ref)}` : ""}`;
  let payload: unknown;
  try {
    payload = await fetchGitHubJson(env, contents, auth.token);
  } catch (error) {
    if (error instanceof Error && error.message === "github_api_404") throw new GitHubFileError("github_file_not_found", 404);
    throw new GitHubFileError("github_read_failed", 502);
  }
  const item = githubObject(payload);
  if (Array.isArray(payload) || item.type !== "file") throw new GitHubFileError("github_file_not_a_file", 422);
  // GitHub inlines a file's content up to 1 MiB; a larger one arrives without it.
  const encoded = item.encoding === "base64" && typeof item.content === "string" ? item.content.replace(/\s/gu, "") : "";
  let text: string | null = null;
  let truncated = false;
  if (encoded) {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    try {
      text = bytes.includes(0) ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = null;
    }
    if (text !== null && text.length > GITHUB_FILE_TEXT_LIMIT) {
      text = text.slice(0, GITHUB_FILE_TEXT_LIMIT);
      truncated = true;
    }
  }
  return {
    repository: `${file.owner}/${file.repo}`,
    path: file.path,
    ref: file.ref,
    sha: githubString(item.sha) || "",
    size: typeof item.size === "number" ? item.size : 0,
    htmlUrl: githubString(item.html_url) || null,
    text,
    truncated,
  };
}

/**
 * Publishes a completed check run on a commit with this Space's GitHub
 * installation, for a repository that installation covers. Maintainers can
 * make the check required.
 */
export async function publishGitHubCheckRun(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  repository: { owner: string; repo: string },
  check: { name: string; headSha: string; conclusion: "success" | "failure"; title: string; summary: string;
    detailsUrl?: string }
): Promise<void> {
  const auth = await githubInstallationAuthWithCapability(env, connection, "github.checks.write", repository);
  await fetchGitHubJson(env,
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/check-runs`,
    auth.token, { method: "POST", body: JSON.stringify({
      name: check.name, head_sha: check.headSha, status: "completed", conclusion: check.conclusion,
      ...(check.detailsUrl ? { details_url: check.detailsUrl } : {}),
      output: { title: check.title.slice(0, 250), summary: check.summary.slice(0, 60_000) },
    }) });
}

export interface GitHubPullRequestForReview {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  headSha: string;
  /** Whether GitHub states the base repository is public; unstated counts as private. */
  repositoryPublic: boolean;
  author: string;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }>;
  checks: Array<{ name: string; status: string; conclusion: string | null }>;
  openPullRequests: Array<{ number: number; title: string; url: string }>;
}

const REVIEW_PATCH_BUDGET = 60_000;

/**
 * What a pre-review reads of a pull request, with this Space's installation:
 * its change (patches within a budget), the checks on its head commit and the
 * repository's other open pull requests.
 */
export async function readGitHubPullRequestForReview(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  repository: { owner: string; repo: string },
  number: number
): Promise<GitHubPullRequestForReview> {
  const auth = await githubInstallationAuthWithCapability(env, connection, "github.pull_requests.read", repository);
  const repoPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const pull = githubObject(await fetchGitHubJson(env, `${repoPath}/pulls/${number}`, auth.token));
  const headSha = githubString(githubObject(pull.head).sha) || "";
  const [files, checks, open] = await Promise.all([
    fetchGitHubJson(env, `${repoPath}/pulls/${number}/files?per_page=100`, auth.token),
    fetchGitHubJson(env, `${repoPath}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`, auth.token),
    fetchGitHubJson(env, `${repoPath}/pulls?state=open&per_page=50`, auth.token),
  ]);
  let budget = REVIEW_PATCH_BUDGET;
  return {
    number,
    title: githubString(pull.title) || "",
    body: githubString(pull.body) || "",
    draft: githubBoolean(pull.draft) === true,
    headSha,
    repositoryPublic: githubRepositoryIsPublic(githubObject(pull.base).repo),
    author: githubString(githubObject(pull.user).login) || "",
    files: (Array.isArray(files) ? files : []).map((value) => {
      const file = githubObject(value);
      const patch = (githubString(file.patch) || "").slice(0, Math.max(0, budget));
      budget -= patch.length;
      return { filename: githubString(file.filename) || "", status: githubString(file.status) || "",
        additions: githubNumber(file.additions) ?? 0, deletions: githubNumber(file.deletions) ?? 0, patch };
    }),
    checks: (Array.isArray(githubObject(checks).check_runs) ? githubObject(checks).check_runs as unknown[] : [])
      .map((value) => {
        const run = githubObject(value);
        return { name: githubString(run.name) || "", status: githubString(run.status) || "",
          conclusion: githubString(run.conclusion) ?? null };
      })
      .filter((run) => !run.name.startsWith("xmatrix/")),
    openPullRequests: (Array.isArray(open) ? open : []).map(githubObject)
      .filter((item) => githubNumber(item.number) !== number)
      .map((item) => ({ number: githubNumber(item.number) ?? 0, title: githubString(item.title) || "",
        url: githubString(item.html_url) || "" })),
  };
}

/** The commit a pull request's head is at now. */
export async function readGitHubPullRequestHead(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  repository: { owner: string; repo: string },
  number: number
): Promise<string> {
  const auth = await githubInstallationAuthWithCapability(env, connection, "github.pull_requests.read", repository);
  const pull = githubObject(await fetchGitHubJson(env,
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls/${number}`, auth.token));
  const sha = githubString(githubObject(pull.head).sha);
  if (!sha) throw new Error("github_pull_request_head_missing");
  return sha;
}

export async function checkAppConnectorProviderConnection(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView
): Promise<void> {
  if (connection.providerId !== "github") {
    return;
  }
  const installationIds = githubConnectionInstallationIds(connection);
  if (installationIds.length === 0) {
    throw new Error("github_installation_missing");
  }
  let lastError: unknown;
  let anyOk = false;
  for (const installationId of installationIds) {
    try {
      await githubInstallationAuthForId(env, installationId);
      anyOk = true;
    } catch (error) {
      lastError = error;
    }
  }
  // Partial failure is OK: at least one retained installation must still verify.
  if (!anyOk) {
    if (lastError instanceof Error) throw lastError;
    throw new Error("github_installation_token_missing");
  }
}

export async function resolveAppConnectorCompletionOptions(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  source: AppConnectorCompletionDynamicSource,
  parent?: string
): Promise<AppConnectorCompletionOption[]> {
  if (connection.providerId !== "github") {
    throw new Error("connector_completion_source_unsupported");
  }
  const repositories = await fetchGitHubInstallationRepositories(env, connection);
  if (source === "github-organizations") {
    const owners = new Map<string, string>();
    for (const repository of repositories) {
      if (repository.archived) continue;
      const key = repository.owner.toLowerCase();
      if (!owners.has(key)) owners.set(key, repository.owner);
    }
    return Array.from(owners.entries())
      .map(([id, owner]) => ({ id, value: owner, label: owner }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }
  if (source === "github-repositories") {
    const owner = parent?.trim().toLowerCase();
    if (!owner) throw new Error("connector_completion_parent_required");
    return repositories
      .filter((repository) => repository.owner.toLowerCase() === owner && !repository.archived)
      .sort(compareRepositoriesByRecentActivity)
      .map((repository) => ({
        id: repository.id,
        value: repository.name,
        label: repository.name,
        description: repository.private ? "Private repository" : "Repository",
      }));
  }
  throw new Error("connector_completion_source_unsupported");
}

/**
 * How long one Space's repository list is reused. The picker opens repeatedly,
 * and every member of the Space asks the same question, but each answer costs a
 * paged walk of GitHub's installation catalog.
 *
 * A minute is the whole staleness budget: the credential mint re-resolves the
 * connector every single time, so this only decides how long a repo can still be
 * *offered* after access to it changed — never how long one can be used.
 */
const SPACE_LAUNCH_REPOSITORY_CACHE_SECONDS = 60;

const SPACE_LAUNCH_REPOSITORY_CACHE = "xmatrix-space-launch-repositories";

/**
 * The repos a Space may launch an Agent into: exactly the repositories of that
 * Space's connector installations. This is the selection-side twin of
 * `mintGitHubRepositoryToken` — one authorization, asked once for the picker and
 * again for the credential.
 *
 * The cache key carries the installation ids, so connecting or disconnecting an
 * installation is visible immediately rather than after a timeout; only a change
 * *within* an installation waits out the TTL.
 */
export async function spaceLaunchTargetRepositories(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView
): Promise<LaunchTargetRepo[]> {
  if (connection.providerId !== "github") {
    throw new Error("github_connection_required");
  }
  const cacheKey = spaceLaunchRepositoryCacheKey(connection);
  const cached = await readCachedLaunchTargetRepositories(cacheKey);
  if (cached) return cached;
  const repositories = await fetchGitHubInstallationRepositories(env, connection);
  const targets = repositories
    .filter((repository) => !repository.archived)
    .sort(compareRepositoriesByRecentActivity)
    .map((repository) => ({
      value: `${repository.owner}/${repository.name}`,
      private: repository.private,
    }));
  await writeCachedLaunchTargetRepositories(cacheKey, targets);
  return targets;
}

function spaceLaunchRepositoryCacheKey(connection: AppConnectorConnectionView): Request | undefined {
  const installationIds = githubConnectionInstallationIds(connection);
  if (installationIds.length === 0) return undefined;
  // The connection id is `<spaceId>:<providerId>`, so one Space's answer can
  // never be read as another's.
  return new Request(
    `https://launch-targets.xmatrix.internal/${encodeURIComponent(connection.id)}` +
      `/${encodeURIComponent(installationIds.join(","))}`
  );
}

async function readCachedLaunchTargetRepositories(
  key: Request | undefined
): Promise<LaunchTargetRepo[] | undefined> {
  if (!key) return undefined;
  try {
    const cache = await caches.open(SPACE_LAUNCH_REPOSITORY_CACHE);
    const hit = await cache.match(key);
    if (!hit) return undefined;
    const value = await hit.json();
    return Array.isArray(value) ? (value as LaunchTargetRepo[]) : undefined;
  } catch {
    // A cache that cannot answer is not an authorization answer either: fall
    // through to GitHub rather than reporting an empty Space.
    return undefined;
  }
}

async function writeCachedLaunchTargetRepositories(
  key: Request | undefined,
  targets: LaunchTargetRepo[]
): Promise<void> {
  if (!key) return;
  try {
    const cache = await caches.open(SPACE_LAUNCH_REPOSITORY_CACHE);
    await cache.put(key, new Response(JSON.stringify(targets), {
      headers: {
        "cache-control": `max-age=${SPACE_LAUNCH_REPOSITORY_CACHE_SECONDS}`,
        "content-type": "application/json",
      },
    }));
  } catch {
    // Caching is an optimization; failing to store one answer changes nothing
    // about the answer already resolved.
  }
}

export async function executeAppConnectorProviderAction(
  context: AppConnectorProviderExecutionContext
): Promise<AppConnectorProviderExecutionResult> {
  const provider = getAppConnectorProvider(context.mention.appId);
  const action = context.mention.appId === "github" ? (context.mention.actionId || "subscribe") : (context.mention.actionId || "default");
  if (!provider) {
    return { type: "terminal", status: "blocked", reason: "unsupported_provider" };
  }
  if (provider.status !== "available") {
    return { type: "terminal", status: "planned", reason: "planned_connector" };
  }
  if (
    provider.id !== "github" ||
    (action !== "issue_to_channel" && action !== "issue_to_thread" && action !== "subscribe" && action !== "unsubscribe" && action !== "comment" && action !== "create_issue" && action !== "close_issue" && action !== "reopen_issue" && action !== "review" && action !== "merge" && action !== "rerun_failed_jobs" && action !== "dispatch_workflow")
  ) {
    return { type: "terminal", status: "blocked", reason: "unsupported_action" };
  }

  if (action === "create_issue") {
    const input = extractGitHubCreateIssueInput(context.message.body, context.connection);
    if (!input.repository) {
      return { type: "terminal", status: "failed", reason: "missing_github_repository" };
    }
    if (!input.title) {
      return { type: "terminal", status: "failed", reason: "missing_github_issue_title" };
    }
    try {
      const result = await createGitHubIssue(context.env, context.connection, input.repository, input.title, input.body);
      return {
        type: "github_issue_created",
        issue: result.issue,
        capabilities: result.capabilities,
      };
    } catch (error) {
      return githubConnectorTerminalFailure(error);
    }
  }

  if (action === "rerun_failed_jobs") {
    const input = extractGitHubActionsRerunInput(context.message.body, context.connection);
    if (!input.repository) {
      return { type: "terminal", status: "failed", reason: "missing_github_repository" };
    }
    if (!input.runId) {
      return { type: "terminal", status: "failed", reason: "invalid_github_actions_run_id" };
    }
    try {
      const result = await rerunGitHubActionsFailedJobs(context.env, context.connection, input.repository, input.runId);
      return {
        type: "github_actions_failed_jobs_rerun",
        repository: result.repository,
        capabilities: result.capabilities,
        runId: result.runId,
      };
    } catch (error) {
      return githubConnectorTerminalFailure(error);
    }
  }

  if (action === "dispatch_workflow") {
    const parsed = extractGitHubWorkflowDispatchInput(context.message.body, context.connection);
    if ("error" in parsed) {
      return { type: "terminal", status: "failed", reason: parsed.error };
    }
    if (!githubWorkflowDispatchAllowed(context.connection, parsed.workflowId)) {
      return { type: "terminal", status: "blocked", reason: "github_workflow_not_allowed" };
    }
    try {
      const result = await dispatchGitHubWorkflow(context.env, context.connection, parsed);
      return {
        type: "github_workflow_dispatched",
        repository: result.repository,
        capabilities: result.capabilities,
        workflowId: result.workflowId,
        ref: result.ref,
        inputs: result.inputs,
      };
    } catch (error) {
      return githubConnectorTerminalFailure(error);
    }
  }

  const issueRef = extractGitHubIssueRef(context.message.body, context.connection);
  if (!issueRef && (action === "subscribe" || action === "unsubscribe")) {
    const repositoryRef = extractGitHubRepositoryRef(context.message.body, context.connection);
    if (!repositoryRef) {
      return { type: "terminal", status: "failed", reason: "missing_github_issue_or_repository" };
    }
    try {
      const capabilities = await fetchGitHubRepositoryCapabilities(context.env, context.connection, repositoryRef);
      return {
        type: action === "subscribe" ? "github_subscribe_repository" : "github_unsubscribe_repository",
        repository: repositoryRef,
        capabilities,
      };
    } catch (error) {
      return githubConnectorTerminalFailure(error);
    }
  }
  if (!issueRef) {
    return { type: "terminal", status: "failed", reason: "missing_github_issue_url" };
  }

  try {
    if (action === "merge") {
      const result = await mergeGitHubPullRequest(
        context.env,
        context.connection,
        issueRef,
        extractGitHubPullRequestMergeMethod(context.message.body),
      );
      return {
        type: "github_pull_request_merged",
        issue: result.issue,
        capabilities: result.capabilities,
        merge: result.merge,
      };
    }
    if (action === "review") {
      const reviewInput = extractGitHubPullRequestReviewInput(context.message.body);
      if (!reviewInput.event) {
        return { type: "terminal", status: "failed", reason: "missing_github_review_event" };
      }
      if ((reviewInput.event === "REQUEST_CHANGES" || reviewInput.event === "COMMENT") && !reviewInput.body) {
        return { type: "terminal", status: "failed", reason: "missing_github_review_body" };
      }
      const result = await createGitHubPullRequestReview(
        context.env,
        context.connection,
        issueRef,
        reviewInput.event,
        reviewInput.body
      );
      return {
        type: "github_pull_request_review_submitted",
        issue: result.issue,
        capabilities: result.capabilities,
        review: result.review,
      };
    }
    if (action === "close_issue" || action === "reopen_issue") {
      const result = await updateGitHubIssueState(
        context.env,
        context.connection,
        issueRef,
        action === "close_issue" ? "closed" : "open"
      );
      return {
        type: "github_issue_state_changed",
        issue: result.issue,
        capabilities: result.capabilities,
      };
    }
    if (action === "comment") {
      const commentBody = extractGitHubCommentBody(context.message.body);
      if (!commentBody.trim()) {
        return { type: "terminal", status: "failed", reason: "missing_github_comment_body" };
      }
      const result = await createGitHubIssueComment(context.env, context.connection, issueRef, commentBody);
      return {
        type: "github_comment_created",
        issue: result.issue,
        capabilities: result.capabilities,
        comment: result.comment,
      };
    }
    const fetched = await fetchGitHubIssueSnapshot(context.env, context.connection, issueRef);
    return {
      type: action === "subscribe"
        ? "github_subscribe_issue"
        : action === "unsubscribe"
          ? "github_unsubscribe_issue"
          : action === "issue_to_thread"
          ? "github_issue_to_thread"
          : "github_issue_to_channel",
      issue: fetched.issue,
      capabilities: fetched.capabilities,
    };
  } catch (error) {
    return githubConnectorTerminalFailure(error);
  }
}

function extractGitHubCommentBody(body: string | undefined): string {
  const value = body || "";
  const patterns = [
    /(?:^|\s)[@＠][\u200B-\u200D\uFEFF]*github:comment:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?:#?[1-9][0-9]*\b([\s\S]*)$/i,
    /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9][0-9]*\b([\s\S]*)$/i,
    /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*\b([\s\S]*)$/i,
    /(?:^|\s)#[1-9][0-9]*\b([\s\S]*)$/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return (match[1] || "").trim();
  }
  return "";
}

function extractGitHubCreateIssueInput(
  body: string | undefined,
  connection?: AppConnectorConnectionView
): { repository?: { owner: string; repo: string }; title: string; body?: string } {
  const value = body || "";
  const commandMatch = value.match(
    /(?:^|\s)[@＠][\u200B-\u200D\uFEFF]*github:create_issue(?::([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?))?\b([\s\S]*)$/i
  );
  if (!commandMatch) {
    return { repository: githubConnectionRepository(connection), title: "" };
  }
  const repository = commandMatch[1]
    ? githubRepositoryRef(commandMatch[1], connection)
    : githubConnectionRepository(connection);
  const content = (commandMatch[2] || "").trim();
  const [firstLine, ...rest] = content.split(/\r?\n/);
  return {
    repository,
    title: (firstLine || "").trim(),
    body: rest.join("\n").trim() || undefined,
  };
}

function extractGitHubPullRequestReviewInput(
  body: string | undefined
): { event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string } {
  const value = body || "";
  const match = value.match(
    /(?:^|\s)[@＠][\u200B-\u200D\uFEFF]*github:review:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?:#?[1-9][0-9]*\b(?:\s+([A-Za-z_-]+))?([\s\S]*)$/i
  );
  const action = (match?.[1] || "").trim().toLowerCase().replace(/-/g, "_");
  const event = action === "approve"
    ? "APPROVE"
    : action === "request_changes"
    ? "REQUEST_CHANGES"
    : action === "comment"
    ? "COMMENT"
    : undefined;
  return {
    event,
    body: (match?.[2] || "").trim() || undefined,
  };
}

function extractGitHubPullRequestMergeMethod(
  body: string | undefined
): "merge" | "squash" | "rebase" | undefined {
  const value = body || "";
  const match = value.match(
    /(?:^|\s)[@＠][\u200B-\u200D\uFEFF]*github:merge:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?:#?[1-9][0-9]*\b(?:\s+(merge|squash|rebase))?/i
  );
  const method = match?.[1]?.toLowerCase();
  return method === "merge" || method === "squash" || method === "rebase" ? method : undefined;
}

function githubWorkflowDispatchAllowed(
  connection: AppConnectorConnectionView,
  workflowId: string
): boolean {
  return githubActionsWorkflowIds(connection).includes(workflowId);
}

function githubActionsWorkflowIds(connection: AppConnectorConnectionView): string[] {
  const configured = connection.metadata?.actionsWorkflowIds;
  if (!Array.isArray(configured)) return [];
  const ids = configured.filter((value): value is string =>
    typeof value === "string" && value.length <= 128 &&
    /^(?:[1-9][0-9]*|[A-Za-z0-9_.-]+\.ya?ml)$/.test(value)
  );
  return Array.from(new Set(ids)).slice(0, 32);
}

function extractGitHubActionsRerunInput(
  body: string | undefined,
  connection?: AppConnectorConnectionView
): { repository?: GitHubRepositoryRef; runId?: number } {
  const match = (body || "").match(
    /(?:^|\s)[@＠][\u200B-\u200D\uFEFF]*github:rerun_failed_jobs:([^:\s]+):([1-9][0-9]*)\s*$/i
  );
  const repository = match ? githubRepositoryRef(match[1], connection) : undefined;
  const runId = match ? Number(match[2]) : undefined;
  return {
    repository: repository ? { ...repository, htmlUrl: `https://github.com/${repository.owner}/${repository.repo}` } : undefined,
    runId: Number.isSafeInteger(runId) ? runId : undefined,
  };
}

function extractGitHubWorkflowDispatchInput(
  body: string | undefined,
  connection?: AppConnectorConnectionView
): ({
  repository: GitHubRepositoryRef;
  workflowId: string;
  ref: string;
  inputs: Record<string, GitHubWorkflowInputValue>;
} | { error: string }) {
  const match = (body || "").match(
    /(?:^|\s)[@＠][\u200B-\u200D\uFEFF]*github:dispatch_workflow:([^:\s]+):([^:\s]+):([^\s:]+)(?:\s+([\s\S]+?))?\s*$/i
  );
  if (!match) return { error: "invalid_github_workflow_dispatch" };
  const parsedRepository = githubRepositoryRef(match[1], connection);
  if (!parsedRepository) return { error: "missing_github_repository" };
  const workflowId = match[2];
  if (!/^(?:[1-9][0-9]*|[A-Za-z0-9_.-]+\.ya?ml)$/.test(workflowId)) {
    return { error: "invalid_github_workflow_id" };
  }
  const ref = match[3];
  if (!isBoundedGitHubRef(ref)) return { error: "invalid_github_workflow_ref" };
  const inputText = match[4]?.trim();
  const inputs = inputText ? parseGitHubWorkflowInputs(inputText) : {};
  if (!inputs) return { error: "invalid_github_workflow_inputs" };
  return {
    repository: {
      ...parsedRepository,
      htmlUrl: `https://github.com/${parsedRepository.owner}/${parsedRepository.repo}`,
    },
    workflowId,
    ref,
    inputs,
  };
}

function isBoundedGitHubRef(ref: string): boolean {
  return ref.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes("..") && !ref.includes("//") && !ref.includes("@{") &&
    !ref.endsWith("/") && !ref.endsWith(".") && !ref.endsWith(".lock");
}

function parseGitHubWorkflowInputs(text: string): Record<string, GitHubWorkflowInputValue> | undefined {
  if (text.length > 8 * 1024) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 10) return undefined;
  const inputs: Record<string, GitHubWorkflowInputValue> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) return undefined;
    if (typeof item === "string") {
      if (item.length > 1024) return undefined;
      inputs[key] = item;
    } else if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      inputs[key] = item;
    } else {
      return undefined;
    }
  }
  return inputs;
}

function extractGitHubIssueRef(body: string, connection?: AppConnectorConnectionView): GitHubIssueRef | undefined {
  const subscribeMatch = body.match(/(?:^|\s)[@＠][\u200B-\u200D\uFEFF]*github:(?:subscribe|unsubscribe|comment|close_issue|reopen_issue|review|merge):([^:\s]+):#?([1-9][0-9]*)\b/i);
  if (subscribeMatch) {
    const repository = githubRepositoryRef(subscribeMatch[1], connection);
    if (repository) {
      return githubIssueRef(repository.owner, repository.repo, subscribeMatch[2]);
    }
  }
  const urlMatch = body.match(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9][0-9]*)\b/i);
  if (urlMatch) {
    return githubIssueRef(urlMatch[1], urlMatch[2], urlMatch[3]);
  }
  const fullRefMatch = body.match(/\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/);
  if (fullRefMatch) {
    return githubIssueRef(fullRefMatch[1], fullRefMatch[2], fullRefMatch[3]);
  }
  const shortRefMatch = body.match(/(?:^|\s)#([1-9][0-9]*)\b/);
  const repository = shortRefMatch ? githubConnectionRepository(connection) : undefined;
  if (shortRefMatch && repository) {
    return githubIssueRef(repository.owner, repository.repo, shortRefMatch[1]);
  }
  return undefined;
}

function extractGitHubRepositoryRef(
  body: string,
  connection?: AppConnectorConnectionView
): GitHubRepositoryRef | undefined {
  const urlMatch = body.match(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[\s/#?]|$)/i);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      htmlUrl: `https://github.com/${urlMatch[1]}/${urlMatch[2]}`,
    };
  }
  const commandMatch = body.match(
    /(?:^|\s)[@＠][\u200B-\u200D\uFEFF]*github:(?:subscribe|unsubscribe)(?::([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?))?(?:\s+|$)/i
  );
  if (!commandMatch) return undefined;
  const repository = commandMatch?.[1]
    ? githubRepositoryRef(commandMatch[1], connection)
    : githubConnectionRepository(connection);
  if (repository) {
    return {
      ...repository,
      htmlUrl: `https://github.com/${repository.owner}/${repository.repo}`,
    };
  }
  return undefined;
}

function githubRepositoryRef(
  input: string,
  connection?: AppConnectorConnectionView
): { owner: string; repo: string } | undefined {
  const repository = input.includes("/")
    ? input
    : githubSubscribeRepositoryWithDefaultOwner(input, connection);
  const repoMatch = repository?.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return repoMatch ? { owner: repoMatch[1], repo: repoMatch[2] } : undefined;
}

function githubSubscribeRepositoryWithDefaultOwner(
  repoInput: string,
  connection?: AppConnectorConnectionView
): string | undefined {
  const repository = githubConnectionRepository(connection);
  return repository ? `${repository.owner}/${repoInput.trim()}` : undefined;
}

function githubIssueRef(ownerInput: string, repoInput: string, numberInput: string): GitHubIssueRef | undefined {
  const owner = ownerInput.trim();
  const repo = repoInput.trim();
  const issueNumber = Number.parseInt(numberInput, 10);
  if (!Number.isSafeInteger(issueNumber)) return undefined;
  return {
    owner,
    repo,
    issueNumber,
    htmlUrl: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
  };
}

function githubConnectionRepository(
  connection?: AppConnectorConnectionView
): { owner: string; repo: string } | undefined {
  const metadata = connection?.metadata || {};
  const value =
    (typeof metadata.repository === "string" && metadata.repository) ||
    (typeof metadata.githubRepository === "string" && metadata.githubRepository) ||
    "";
  const match = value.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

async function fetchGitHubRepositoryCapabilities(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  ref: GitHubRepositoryRef
): Promise<string[]> {
  const auth = await githubInstallationAuthForRepository(env, connection, ref.owner, ref.repo);
  if (!githubAuthHasCapability(auth, connection, "github.issues.read")) {
    throw new Error("missing_capabilities:github.issues.read");
  }
  return auth.capabilities;
}

async function fetchGitHubIssueSnapshot(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  ref: GitHubIssueRef
): Promise<GitHubIssueFetchResult> {
  const issuePath = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.issueNumber}`;
  const auth = await githubInstallationAuthForRepository(env, connection, ref.owner, ref.repo);
  if (
    !githubAuthHasCapability(auth, connection, "github.issues.read") &&
    !githubAuthHasCapability(auth, connection, "github.pull_requests.read")
  ) {
    throw new Error("missing_capabilities:github.issues.read");
  }
  const issue = await fetchGitHubJson(env, issuePath, auth.token);
  const issueObject = githubObject(issue);
  const isPullRequest = Object.keys(githubObject(issueObject.pull_request)).length > 0;
  if (isPullRequest && !githubAuthHasCapability(auth, connection, "github.pull_requests.read")) {
    throw new Error("missing_capabilities:github.pull_requests.read");
  }
  const pullRequest = isPullRequest
    ? await fetchGitHubPullRequestSnapshot(env, auth.token, ref)
    : undefined;
  let comments: unknown[] = [];
  try {
    comments = await fetchGitHubIssueComments(env, issuePath, auth.token);
  } catch {
    comments = [];
  }
  return {
    issue: {
      ref,
      kind: isPullRequest ? "pull_request" : "issue",
      title: githubString(issueObject.title) || `${ref.owner}/${ref.repo}#${ref.issueNumber}`,
      state: githubString(issueObject.state) || "unknown",
      author: githubUserLogin(issueObject.user),
      body: githubString(issueObject.body),
      htmlUrl: pullRequest?.htmlUrl || githubString(issueObject.html_url) || ref.htmlUrl,
      labels: githubIssueLabels(issueObject.labels),
      pullRequest,
      comments: comments.map((comment) => {
        const commentObject = githubObject(comment);
        return {
          author: githubUserLogin(commentObject.user),
          body: githubString(commentObject.body),
          htmlUrl: githubString(commentObject.html_url),
          createdAt: githubString(commentObject.created_at),
        };
      }),
    },
    capabilities: auth.capabilities,
  };
}

async function createGitHubIssueComment(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  ref: GitHubIssueRef,
  body: string
): Promise<GitHubIssueCommentResult> {
  const { auth, fetched } = await githubIssueWriteAuth(env, connection, ref);
  const payload = await fetchGitHubJson(
    env,
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.issueNumber}/comments`,
    auth.token,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    }
  );
  const comment = githubObject(payload);
  return {
    issue: fetched.issue,
    capabilities: auth.capabilities,
    comment: {
      author: githubUserLogin(comment.user),
      body: githubString(comment.body),
      htmlUrl: githubString(comment.html_url),
      createdAt: githubString(comment.created_at),
    },
  };
}

async function createGitHubIssue(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  repository: { owner: string; repo: string },
  title: string,
  body: string | undefined
): Promise<GitHubIssueCreateResult> {
  const requiredCapability = "github.issues.write";
  const auth = await githubInstallationAuthWithCapability(env, connection, requiredCapability, repository);
  const payload = await fetchGitHubJson(
    env,
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/issues`,
    auth.token,
    {
      method: "POST",
      body: JSON.stringify({
        title,
        ...(body ? { body } : {}),
      }),
    }
  );
  const issueObject = githubObject(payload);
  const issueNumber = githubNumber(issueObject.number);
  if (!issueNumber) {
    throw new Error("github_issue_create_missing_number");
  }
  const ref = githubIssueRef(repository.owner, repository.repo, String(issueNumber));
  if (!ref) {
    throw new Error("github_issue_create_invalid_ref");
  }
  return {
    issue: {
      ref,
      kind: "issue",
      title: githubString(issueObject.title) || title,
      state: githubString(issueObject.state) || "open",
      author: githubUserLogin(issueObject.user),
      body: githubString(issueObject.body),
      htmlUrl: githubString(issueObject.html_url) || ref.htmlUrl,
      labels: githubIssueLabels(issueObject.labels),
      comments: [],
    },
    capabilities: auth.capabilities,
  };
}

async function updateGitHubIssueState(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  ref: GitHubIssueRef,
  state: "closed" | "open"
): Promise<GitHubIssueStateChangeResult> {
  const { auth, fetched } = await githubIssueWriteAuth(env, connection, ref);
  const payload = await fetchGitHubJson(
    env,
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.issueNumber}`,
    auth.token,
    {
      method: "PATCH",
      body: JSON.stringify({ state }),
    }
  );
  const issueObject = githubObject(payload);
  return {
    issue: {
      ...fetched.issue,
      state: githubString(issueObject.state) || state,
      title: githubString(issueObject.title) || fetched.issue.title,
      body: githubString(issueObject.body) || fetched.issue.body,
      htmlUrl: githubString(issueObject.html_url) || fetched.issue.htmlUrl,
      labels: githubIssueLabels(issueObject.labels),
    },
    capabilities: auth.capabilities,
  };
}

async function createGitHubPullRequestReview(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  ref: GitHubIssueRef,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body: string | undefined
): Promise<GitHubPullRequestReviewResult> {
  const fetched = await fetchGitHubIssueSnapshot(env, connection, ref);
  if (fetched.issue.kind !== "pull_request") {
    throw new Error("github_review_target_not_pull_request");
  }
  const auth = await githubInstallationAuthWithCapability(
    env,
    connection,
    "github.pull_requests.write",
    { owner: ref.owner, repo: ref.repo }
  );
  const payload = await fetchGitHubJson(
    env,
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.issueNumber}/reviews`,
    auth.token,
    {
      method: "POST",
      body: JSON.stringify({
        event,
        ...(body ? { body } : {}),
      }),
    }
  );
  const review = githubObject(payload);
  return {
    issue: fetched.issue,
    capabilities: auth.capabilities,
    review: {
      author: githubUserLogin(review.user),
      body: githubString(review.body),
      htmlUrl: githubString(review.html_url),
      submittedAt: githubString(review.submitted_at),
      state: githubString(review.state),
    },
  };
}

async function mergeGitHubPullRequest(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  ref: GitHubIssueRef,
  method: "merge" | "squash" | "rebase" | undefined
): Promise<GitHubPullRequestMergeResult> {
  const fetched = await fetchGitHubIssueSnapshot(env, connection, ref);
  if (fetched.issue.kind !== "pull_request") {
    throw new Error("github_merge_target_not_pull_request");
  }
  const auth = await githubInstallationAuthWithCapability(
    env,
    connection,
    "github.pull_requests.write",
    { owner: ref.owner, repo: ref.repo }
  );
  const payload = githubObject(await fetchGitHubJson(
    env,
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.issueNumber}/merge`,
    auth.token,
    {
      method: "PUT",
      body: JSON.stringify(method ? { merge_method: method } : {}),
    }
  ));
  const merged = githubBoolean(payload.merged) === true;
  const message = githubString(payload.message);
  if (!merged) {
    throw new Error(`github_pull_request_not_merged${message ? `:${message}` : ""}`);
  }
  return {
    issue: {
      ...fetched.issue,
      state: "closed",
      pullRequest: fetched.issue.pullRequest
        ? { ...fetched.issue.pullRequest, merged: true }
        : fetched.issue.pullRequest,
    },
    capabilities: auth.capabilities,
    merge: {
      merged,
      sha: githubString(payload.sha),
      message,
      method,
    },
  };
}

async function rerunGitHubActionsFailedJobs(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  repository: GitHubRepositoryRef,
  runId: number
): Promise<GitHubActionsRerunResult> {
  const auth = await githubInstallationAuthWithCapability(
    env,
    connection,
    "github.actions.write",
    repository
  );
  await fetchGitHubJson(
    env,
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/actions/runs/${runId}/rerun-failed-jobs`,
    auth.token,
    { method: "POST" }
  );
  return { repository, capabilities: auth.capabilities, runId };
}

async function dispatchGitHubWorkflow(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  input: {
    repository: GitHubRepositoryRef;
    workflowId: string;
    ref: string;
    inputs: Record<string, GitHubWorkflowInputValue>;
  }
): Promise<GitHubWorkflowDispatchResult> {
  const auth = await githubInstallationAuthWithCapability(
    env,
    connection,
    "github.actions.write",
    input.repository
  );
  await fetchGitHubJson(
    env,
    `/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.repo)}/actions/workflows/${encodeURIComponent(input.workflowId)}/dispatches`,
    auth.token,
    {
      method: "POST",
      body: JSON.stringify({
        ref: input.ref,
        ...(Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {}),
      }),
    }
  );
  return { ...input, capabilities: auth.capabilities };
}

async function githubIssueWriteAuth(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  ref: GitHubIssueRef
): Promise<{ auth: GitHubInstallationAuth; fetched: GitHubIssueFetchResult }> {
  const fetched = await fetchGitHubIssueSnapshot(env, connection, ref);
  const requiredCapability = fetched.issue.kind === "pull_request"
    ? "github.pull_requests.write"
    : "github.issues.write";
  if (!githubAuthHasCapability({ token: "", capabilities: fetched.capabilities }, connection, requiredCapability)) {
    throw new Error(`missing_capabilities:${requiredCapability}`);
  }
  return {
    auth: await githubInstallationAuthWithCapability(
      env,
      connection,
      requiredCapability,
      { owner: ref.owner, repo: ref.repo }
    ),
    fetched,
  };
}

function githubAuthHasCapability(
  auth: GitHubInstallationAuth,
  connection: AppConnectorConnectionView,
  capability: string
): boolean {
  if (auth.capabilities.includes(capability)) return true;
  // Actions mutations require the capability reported by the freshly minted
  // installation token. Persisted connection scopes must never widen it.
  if (capability === "github.actions.write") return false;
  if (connection.capabilities?.length) return connection.capabilities.includes(capability);
  if (capability === "github.metadata.read") return connection.scopes?.includes("metadata:read") || false;
  if (capability === "github.issues.read") return connection.scopes?.includes("issues:read") || false;
  if (capability === "github.issues.write") return connection.scopes?.includes("issues:write") || false;
  if (capability === "github.pull_requests.read") return connection.scopes?.includes("pull_requests:read") || false;
  if (capability === "github.pull_requests.write") return connection.scopes?.includes("pull_requests:write") || false;
  if (capability === "github.checks.read") return connection.scopes?.includes("checks:read") || false;
  return false;
}

async function githubInstallationAuthWithCapability(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  capability: string,
  repository?: { owner: string; repo: string }
): Promise<GitHubInstallationAuth> {
  const auth = repository
    ? await githubInstallationAuthForRepository(env, connection, repository.owner, repository.repo)
    : await githubInstallationAuth(env, connection);
  if (!githubAuthHasCapability(auth, connection, capability)) {
    throw new Error(`missing_capabilities:${capability}`);
  }
  return auth;
}

async function fetchGitHubIssueComments(env: AppConnectorEnv, issuePath: string, token: string): Promise<unknown[]> {
  const comments: unknown[] = [];
  for (let page = 1; page <= GITHUB_CONNECTOR_COMMENT_PAGE_LIMIT; page += 1) {
    const path = `${issuePath}/comments?per_page=${GITHUB_CONNECTOR_COMMENT_PAGE_SIZE}&page=${page}`;
    const payload = await fetchGitHubJson(env, path, token);
    if (!Array.isArray(payload) || payload.length === 0) break;
    comments.push(...payload);
    if (payload.length < GITHUB_CONNECTOR_COMMENT_PAGE_SIZE) break;
  }
  return comments;
}

async function fetchGitHubPullRequestSnapshot(
  env: AppConnectorEnv,
  token: string,
  ref: GitHubIssueRef
): Promise<GitHubIssueSnapshot["pullRequest"] & { htmlUrl?: string }> {
  const repoPath = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const pullPath = `${repoPath}/pulls/${ref.issueNumber}`;
  const pull = githubObject(await fetchGitHubJson(env, pullPath, token));
  let files: unknown[] = [];
  try {
    const payload = await fetchGitHubJson(env, `${pullPath}/files?per_page=20`, token);
    files = Array.isArray(payload) ? payload.slice(0, 20) : [];
  } catch {
    files = [];
  }
  const base = githubObject(pull.base);
  const head = githubObject(pull.head);
  return {
    htmlUrl: githubString(pull.html_url),
    baseRef: githubString(base.ref),
    baseSha: githubString(base.sha),
    headRef: githubString(head.ref),
    headSha: githubString(head.sha),
    draft: githubBoolean(pull.draft),
    merged: githubBoolean(pull.merged),
    mergeable: githubBoolean(pull.mergeable),
    additions: githubNumber(pull.additions),
    deletions: githubNumber(pull.deletions),
    changedFiles: githubNumber(pull.changed_files),
    commits: githubNumber(pull.commits),
    files: files.map((file) => {
      const fileObject = githubObject(file);
      return {
        filename: githubString(fileObject.filename) || "(unknown file)",
        status: githubString(fileObject.status),
        additions: githubNumber(fileObject.additions),
        deletions: githubNumber(fileObject.deletions),
        changes: githubNumber(fileObject.changes),
        blobUrl: githubString(fileObject.blob_url),
      };
    }),
  };
}

async function githubInstallationAuth(env: AppConnectorEnv, connection: AppConnectorConnectionView): Promise<GitHubInstallationAuth> {
  const installationIds = githubConnectionInstallationIds(connection);
  if (installationIds.length === 0) {
    throw new Error("github_installation_missing");
  }
  let lastError: unknown;
  for (const installationId of installationIds) {
    try {
      return await githubInstallationAuthForId(env, installationId);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("github_installation_token_missing");
}

/**
 * Resolve the exact GitHub App installation for owner/repo, verify it belongs to this
 * Space connection, then mint a short-lived installation token for that id only.
 */
async function githubInstallationAuthForRepository(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView,
  owner: string,
  repo: string,
  permissions?: GitHubPermissionRequest
): Promise<GitHubInstallationAuth> {
  const allowed = githubConnectionInstallationIds(connection);
  if (allowed.length === 0) {
    throw new Error("github_installation_missing");
  }
  const scope = { repositories: [repo], ...(permissions ? { permissions } : {}) };

  let resolvedId: string;
  try {
    resolvedId = await resolveGitHubRepositoryInstallationId(env, owner, repo);
  } catch (error) {
    // A 404 is GitHub's answer, not an outage: the App is not installed on
    // that repository, or the repository does not exist. Probing would only
    // replace that answer with a less precise one.
    if (error instanceof Error && error.message === "github_api_404") {
      throw new Error("github_repository_not_installed");
    }
    return await githubInstallationAuthByProbe(env, allowed, owner, repo, scope, error);
  }
  if (!allowed.includes(resolvedId)) {
    // The lookup answered: the repository belongs to an installation this
    // Space did not connect. That is the precise refusal, and no other
    // installation may stand in for it.
    throw new Error("github_installation_not_linked_to_space");
  }
  return await githubInstallationAuthForId(env, resolvedId, scope);
}

/**
 * Only when the installation lookup itself is unavailable: try each of the
 * Space's installations. `repositories` names a repository *within* an
 * installation's account, so a same-named repository of another owner would
 * mint too; a token is accepted only when it covers exactly `owner/repo`.
 */
async function githubInstallationAuthByProbe(
  env: AppConnectorEnv,
  allowed: string[],
  owner: string,
  repo: string,
  scope: { repositories: string[]; permissions?: GitHubPermissionRequest },
  lookupError: unknown
): Promise<GitHubInstallationAuth> {
  let lastError: unknown = lookupError;
  for (const installationId of allowed) {
    try {
      const auth = await githubInstallationAuthForId(env, installationId, scope);
      const covered = auth.repositories ?? await githubTokenRepositories(env, auth.token);
      if (covered.some((fullName) => fullName.toLowerCase() === `${owner}/${repo}`.toLowerCase())) return auth;
      lastError = new Error("github_installation_not_linked_to_space");
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("github_installation_token_missing");
}

/** The repositories one installation token reaches; a scoped token has one. */
async function githubTokenRepositories(env: AppConnectorEnv, token: string): Promise<string[]> {
  const payload = githubObject(await fetchGitHubJson(env, "/installation/repositories?per_page=100", token));
  return githubRepositoryFullNames(payload.repositories);
}

function githubRepositoryFullNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => githubString(githubObject(item).full_name))
    .filter((name): name is string => !!name);
}

async function resolveGitHubRepositoryInstallationId(
  env: AppConnectorEnv,
  owner: string,
  repo: string
): Promise<string> {
  const jwt = await configuredGitHubAppJwt(env);
  const payload = githubObject(
    await fetchGitHubJson(
      env,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      jwt
    )
  );
  const installationId =
    githubString(payload.id) ||
    (typeof payload.id === "number" && Number.isFinite(payload.id) ? String(payload.id) : undefined);
  if (!installationId) {
    throw new Error("github_installation_missing");
  }
  return installationId;
}

/**
 * Mint an installation token. When `repositories` is given the token is down-scoped to
 * exactly those repositories, so a leaked or misused token cannot reach the rest of the
 * installation. GitHub rejects the mint (422) if a listed repository is not installed,
 * which callers use as the "not linked to this Space" signal.
 */
async function githubInstallationAuthForId(
  env: AppConnectorEnv,
  installationId: string,
  scope?: { repositories?: string[]; permissions?: GitHubPermissionRequest }
): Promise<GitHubInstallationAuth> {
  const jwt = await configuredGitHubAppJwt(env);
  const repositories = scope?.repositories?.filter((name) => name.length > 0);
  const request = {
    ...(repositories && repositories.length > 0 ? { repositories } : {}),
    ...(scope?.permissions ? { permissions: scope.permissions } : {}),
  };
  const payload = await fetchGitHubJson(env, `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, jwt, {
    method: "POST",
    ...(Object.keys(request).length > 0 ? { body: JSON.stringify(request) } : {}),
  });
  const token = githubString(githubObject(payload).token);
  if (!token) {
    throw new Error("github_installation_token_missing");
  }
  const listed = githubObject(payload).repositories;
  return {
    token,
    capabilities: githubInstallationCapabilities(payload),
    expiresAt: githubString(githubObject(payload).expires_at),
    ...(Array.isArray(listed) ? { repositories: githubRepositoryFullNames(listed) } : {}),
  };
}

async function fetchGitHubInstallationTargetId(env: AppConnectorEnv, installationId: string): Promise<string | undefined> {
  const jwt = await configuredGitHubAppJwt(env);
  const payload = githubObject(
    await fetchGitHubJson(env, `/app/installations/${encodeURIComponent(installationId)}`, jwt)
  );
  const account = githubObject(payload.account);
  const targetId = githubNumber(account.id);
  return typeof targetId === "number" ? String(targetId) : undefined;
}

async function fetchGitHubInstallationRepositories(
  env: AppConnectorEnv,
  connection: AppConnectorConnectionView
): Promise<GitHubInstallationRepository[]> {
  const installationIds = githubConnectionInstallationIds(connection);
  if (installationIds.length === 0) {
    throw new Error("github_installation_missing");
  }
  const repositories = new Map<string, GitHubInstallationRepository>();
  let lastError: unknown;
  let succeeded = 0;
  for (const installationId of installationIds) {
    try {
      const auth = await githubInstallationAuthForId(env, installationId);
      for (let page = 1; page <= GITHUB_CONNECTOR_REPOSITORY_PAGE_LIMIT; page += 1) {
        const payload = githubObject(
          await fetchGitHubJson(
            env,
            `/installation/repositories?per_page=${GITHUB_CONNECTOR_REPOSITORY_PAGE_SIZE}&page=${page}`,
            auth.token
          )
        );
        const pageRepositories = Array.isArray(payload.repositories) ? payload.repositories : [];
        for (const item of pageRepositories) {
          const repository = githubObject(item);
          const owner = githubString(githubObject(repository.owner).login)?.trim().slice(0, 160);
          const name = githubString(repository.name)?.trim().slice(0, 160);
          if (!owner || !name) continue;
          const fullName = githubString(repository.full_name)?.trim().slice(0, 321) || `${owner}/${name}`;
          const id = String(githubNumber(repository.id) ?? fullName.toLowerCase());
          const activityAtMs = githubRepositoryActivityMs(repository);
          const existing = repositories.get(id);
          if (existing && existing.activityAtMs >= activityAtMs) continue;
          repositories.set(id, {
            id,
            owner,
            name,
            private: githubBoolean(repository.private) === true,
            archived: githubBoolean(repository.archived) === true,
            activityAtMs,
          });
        }
        if (pageRepositories.length < GITHUB_CONNECTOR_REPOSITORY_PAGE_SIZE) break;
      }
      succeeded += 1;
    } catch (error) {
      // Keep other orgs visible when one installation is temporarily broken.
      lastError = error;
    }
  }
  if (succeeded === 0) {
    if (lastError instanceof Error) throw lastError;
    throw new Error("github_installation_token_missing");
  }
  return Array.from(repositories.values());
}

function githubInstallationCapabilities(payload: unknown): string[] {
  const permissions = githubObject(githubObject(payload).permissions);
  const capabilities: string[] = [];
  if (githubPermissionAllowsRead(permissions.metadata)) capabilities.push("github.metadata.read");
  if (githubPermissionAllowsRead(permissions.contents)) capabilities.push("github.contents.read");
  if (githubPermissionAllowsWrite(permissions.contents)) capabilities.push("github.contents.write");
  if (githubPermissionAllowsRead(permissions.issues)) capabilities.push("github.issues.read");
  if (githubPermissionAllowsWrite(permissions.issues)) capabilities.push("github.issues.write");
  if (githubPermissionAllowsRead(permissions.pull_requests)) capabilities.push("github.pull_requests.read");
  if (githubPermissionAllowsWrite(permissions.pull_requests)) capabilities.push("github.pull_requests.write");
  if (githubPermissionAllowsRead(permissions.checks)) capabilities.push("github.checks.read");
  if (githubPermissionAllowsWrite(permissions.checks)) capabilities.push("github.checks.write");
  if (githubPermissionAllowsWrite(permissions.actions)) capabilities.push("github.actions.write");
  // GitHub exposes `workflows` as write-only: there is no read level to derive.
  if (githubPermissionAllowsWrite(permissions.workflows)) capabilities.push("github.workflows.write");
  return capabilities;
}

function githubPermissionAllowsRead(value: unknown): boolean {
  return value === "read" || value === "write";
}

function githubPermissionAllowsWrite(value: unknown): boolean {
  return value === "write";
}

/** A JWT signed with this deployment's GitHub App credentials. */
async function configuredGitHubAppJwt(env: AppConnectorEnv): Promise<string> {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) {
    throw new Error("github_app_not_configured");
  }
  return githubAppJwt(appId, privateKey);
}

async function githubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncodeValue(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncodeValue(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncodeValue(signature)}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalizedPem = pem.replace(/\\n/g, "\n").trim();
  const pkcs8Body = pemBody(normalizedPem, "PRIVATE KEY");
  if (pkcs8Body) {
    return base64ToArrayBuffer(pkcs8Body);
  }

  const pkcs1Body = pemBody(normalizedPem, "RSA PRIVATE KEY");
  if (pkcs1Body) {
    const wrapped = wrapPkcs1RsaPrivateKeyInPkcs8(new Uint8Array(base64ToArrayBuffer(pkcs1Body)));
    const bytes = new Uint8Array(wrapped);
    return bytes.buffer;
  }

  throw new Error("github_private_key_invalid_format");
}

function pemBody(pem: string, label: string): string | undefined {
  const pattern = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`);
  const match = pem.match(pattern);
  return match ? match[1].replace(/\s+/g, "") : undefined;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  return base64DecodeBytes(value).buffer;
}

function wrapPkcs1RsaPrivateKeyInPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = derInteger(0);
  const algorithm = derSequence(
    derObjectIdentifier([1, 2, 840, 113549, 1, 1, 1]),
    derNull()
  );
  return derSequence(version, algorithm, derOctetString(pkcs1));
}

function derSequence(...parts: Uint8Array[]): Uint8Array {
  return derTagged(0x30, concatBytes(...parts));
}

function derInteger(value: number): Uint8Array {
  return derTagged(0x02, new Uint8Array([value]));
}

function derNull(): Uint8Array {
  return new Uint8Array([0x05, 0x00]);
}

function derOctetString(value: Uint8Array): Uint8Array {
  return derTagged(0x04, value);
}

function derObjectIdentifier(parts: number[]): Uint8Array {
  if (parts.length < 2) {
    throw new Error("invalid_oid");
  }
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let value = part >> 7;
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80);
      value >>= 7;
    }
    bytes.push(...stack);
  }
  return derTagged(0x06, new Uint8Array(bytes));
}

function derTagged(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function fetchGitHubJson(
  env: AppConnectorEnv,
  path: string,
  bearerToken?: string,
  init?: { method?: "GET" | "POST" | "PATCH" | "PUT" }
    & { body?: BodyInit }
): Promise<unknown> {
  const base = (env.GITHUB_API_BASE_URL || "https://api.github.com").replace(/\/+$/, "");
  const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "user-agent": "xmatrix-app-connector",
    "x-github-api-version": "2022-11-28",
  });
  if (bearerToken) {
    headers.set("authorization", `Bearer ${bearerToken}`);
  }
  if (init?.body) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, { method: init?.method || "GET", headers, body: init?.body });
  if (!response.ok) {
    throw new Error(`github_api_${response.status}`);
  }
  if (response.status === 204) return {};
  const responseText = await response.text();
  return responseText ? JSON.parse(responseText) : {};
}

function githubConnectorTerminalFailure(error: unknown): AppConnectorProviderExecutionResult {
  const reason = githubConnectorErrorReason(error);
  return { type: "terminal", status: reason.startsWith("missing_capabilities:") ? "blocked" : "failed", reason };
}

function githubConnectorErrorReason(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("missing_capabilities:")) {
    return error.message;
  }
  if (error instanceof Error && /^github_api_\d+$/.test(error.message)) {
    return error.message;
  }
  if (error instanceof Error && error.message.startsWith("github_")) {
    return error.message;
  }
  return "github_issue_fetch_failed";
}

function githubObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function githubString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function githubNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function githubBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function githubTimestampMs(value: unknown): number {
  const raw = githubString(value);
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function githubRepositoryActivityMs(repository: Record<string, unknown>): number {
  return githubTimestampMs(repository.pushed_at) || githubTimestampMs(repository.updated_at);
}

function compareRepositoriesByRecentActivity(
  left: GitHubInstallationRepository,
  right: GitHubInstallationRepository
): number {
  if (left.activityAtMs !== right.activityAtMs) return right.activityAtMs - left.activityAtMs;
  return `${left.owner}/${left.name}`.localeCompare(`${right.owner}/${right.name}`);
}

function githubUserLogin(value: unknown): string | undefined {
  const user = githubObject(value);
  return githubString(user.login);
}

function githubIssueLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => {
      if (typeof label === "string") return label.trim();
      const labelObject = githubObject(label);
      return githubString(labelObject.name) || "";
    })
    .filter(Boolean)
    .slice(0, 20);
}
