import { appCommand, findAppConnection } from "./apps";
import { githubConnectionInstallationFor, readGitHubWorkflowRun } from "./app-connectors";
import { record, text, type GitHubRepositoryFeature } from "./github-subscription-domain";
import type { Env } from "./types";

/*
 * A conversation follows one GitHub Actions workflow run, as it follows a pull
 * request it opened (github-pull-request-subscription.ts): the run's verdict
 * comes back as one message when it completes, and the relation ends then. An
 * Agent that started a release train or a dispatched workflow ends its turn
 * instead of polling GitHub (`gh run watch` asks every three seconds, and
 * every Agent on every machine spends one owner's REST quota), and is woken
 * by the verdict.
 */

/** `workflow_run` deliveries are the `status` feature (github-subscription-domain). */
export const WORKFLOW_RUN_SUBSCRIPTION_FEATURES: GitHubRepositoryFeature[] = ["status"];

const WORKFLOW_RUN_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/(\d{1,20})(?:\/(?:attempts\/\d+|job\/\d+)?)?\/?(?:[?#].*)?$/u;

export class WorkflowRunUrlInvalid extends Error {
  constructor() {
    super("A workflow run is named by its https://github.com/<owner>/<repo>/actions/runs/<id> URL");
  }
}

export function githubWorkflowRunSourceRef(repository: string, runId: number): string {
  return `github:run:${repository}#${runId}`.toLowerCase();
}

/** The repository and run id a workflow run URL names. */
export function parseGitHubWorkflowRunUrl(value: unknown): { owner: string; repo: string; runId: number } {
  const match = WORKFLOW_RUN_URL.exec(typeof value === "string" ? value.trim() : "");
  const runId = Number(match?.[3]);
  if (!match || !Number.isSafeInteger(runId) || runId <= 0) throw new WorkflowRunUrlInvalid();
  return { owner: match[1]!, repo: match[2]!, runId };
}

/** The run a `workflow_run` delivery is about, when it is one. */
export function githubWebhookWorkflowRunId(event: string, payload: Record<string, unknown>): number | undefined {
  if (event !== "workflow_run") return undefined;
  const id = Number(record(payload.workflow_run).id);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * The verdict a followed run posts once it completes; nothing before. A run
 * that is re-run completes again and would say so, but its relation ended
 * with the first verdict.
 */
export function githubWorkflowRunEventMessage(input: {
  event: string;
  payload: Record<string, unknown>;
  repository: { owner: string; repo: string; url: string };
}): { body: string; completed: true } | undefined {
  if (input.event !== "workflow_run" || input.payload.action !== "completed") return undefined;
  const run = record(input.payload.workflow_run);
  const conclusion = text(run.conclusion) || "completed";
  const name = text(run.display_title) || text(run.name) || "Workflow run";
  const number = text(run.run_number);
  const url = text(run.html_url) || `${input.repository.url}/actions/runs/${text(run.id)}`;
  const ref = `${input.repository.owner}/${input.repository.repo}`;
  const label = `[${name}${number ? ` #${number}` : ""}](${url})`;
  const verdict = conclusion === "success" ? "passed" : conclusion === "failure" ? "failed" : conclusion;
  return { body: `Workflow run ${label} in ${ref} ${verdict}.`, completed: true };
}

export interface WorkflowRunSubscriptionDependencies {
  findConnection: typeof findAppConnection;
  installationFor: typeof githubConnectionInstallationFor;
  readRun: typeof readGitHubWorkflowRun;
  command: typeof appCommand;
}

/**
 * `xmatrix channel subscribe <run URL>`: an Agent subscribes its conversation
 * to a workflow run, as its owner. A run that already completed is answered
 * with its conclusion and not subscribed; one the Space's GitHub connection
 * does not reach is not subscribed either.
 */
export async function subscribeRunToWorkflowRun(env: Env, input: {
  spaceId: string; channelId: string; ownerUserId: string; commandId: string; url: unknown;
}, dependencies: Partial<WorkflowRunSubscriptionDependencies> = {}): Promise<{
  repository: string; runId: number; subscription: "subscribed" | "completed" | "unreachable";
  conclusion?: string; name?: string; url?: string;
}> {
  const { owner, repo, runId } = parseGitHubWorkflowRunUrl(input.url);
  const repository = `${owner}/${repo}`;
  const unreachable = { repository, runId, subscription: "unreachable" as const };
  const connection = await (dependencies.findConnection ?? findAppConnection)(env, { spaceId: input.spaceId,
    providerId: "github", actorUserId: input.ownerUserId });
  if (!connection || connection.status !== "configured") return unreachable;
  try {
    await (dependencies.installationFor ?? githubConnectionInstallationFor)(env, connection, owner, repo);
  } catch {
    return unreachable;
  }
  const run = await (dependencies.readRun ?? readGitHubWorkflowRun)(env, connection, { owner, repo }, runId)
    .catch(() => undefined);
  if (!run) return unreachable;
  const named = { ...(run.name ? { name: run.name } : {}), ...(run.url ? { url: run.url } : {}) };
  if (run.status === "completed") {
    return { repository, runId, subscription: "completed", conclusion: run.conclusion || "completed", ...named };
  }
  await (dependencies.command ?? appCommand)(env, "put-relation", {
    commandId: `product:github-workflow-run:${input.commandId}`.slice(0, 200),
    connectionId: connection.id, channelId: input.channelId, sourceKind: "workflow_run",
    sourceRef: githubWorkflowRunSourceRef(repository, runId),
    features: WORKFLOW_RUN_SUBSCRIPTION_FEATURES,
    principal: { kind: "user", id: input.ownerUserId },
  });
  return { repository, runId, subscription: "subscribed", ...named };
}
