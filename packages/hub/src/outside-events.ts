import { githubRepositoryDelegated } from "./app-connectors";
import { findAppConnection } from "./apps";
import { record, text } from "./github-subscription-domain";
import { occurNornEvent } from "./norn-events";
import { appStream, githubStream } from "./norn-host";
import type { Env } from "./types";

/**
 * Events arrive from outside the Hub here: a pull request merged into a
 * branch, a workflow failing on it, a connected app's event. Each reaches the
 * Norn programs that wait on a matching stream
 * (docs/architecture/norn-host.md, "Events from outside"). A GitHub event is
 * heard only in a Space whose GitHub connection still includes the
 * installation it came from; a connector event only in the Space of the
 * connection its ingress authenticated it to.
 */

interface GitHubOutsideEvent {
  id: string;
  kind: "merged" | "ci-failed";
  summary: string;
  url?: string;
  repository: string;
  branch: string;
  defaultBranch: string;
  installationId: string;
  workflow?: string;
  pullRequest?: number;
}

/** A connector's event for one connection's Space; `authorizedUserId` keeps it to that member's own work. */
interface ConnectorOutsideEvent {
  spaceId: string;
  provider: string;
  authorizedUserId?: string;
  event: { eventId: string; sourceRef: string; feature: string; summary: string; url?: string };
}

/** Whether a member's Space is connected to what an event came from. */
type SpaceConnected = (spaceId: string, userId: string) => Promise<boolean>;

/** The outside event a GitHub webhook is, if any. */
export function githubOutsideEvent(event: string, payload: Record<string, unknown>): GitHubOutsideEvent | undefined {
  const repository = record(payload.repository);
  const name = text(repository.full_name);
  const installationId = text(record(payload.installation).id);
  if (!name || !installationId) return undefined;
  const base = { repository: name, defaultBranch: text(repository.default_branch) || "main", installationId };
  if (event === "pull_request" && payload.action === "closed" && record(payload.pull_request).merged === true) {
    const pull = record(payload.pull_request);
    const number = Number(pull.number);
    const branch = text(record(pull.base).ref);
    if (!Number.isSafeInteger(number) || !branch) return undefined;
    return { ...base, kind: "merged", branch, pullRequest: number, id: `github:${name}#${number}:merged`,
      summary: `Pull request #${number} “${text(pull.title).slice(0, 120)}” was merged into ${branch}`,
      ...(text(pull.html_url) ? { url: text(pull.html_url) } : {}) };
  }
  if (event === "workflow_run" && payload.action === "completed" &&
      record(payload.workflow_run).conclusion === "failure") {
    const run = record(payload.workflow_run);
    const branch = text(run.head_branch);
    const workflow = text(run.name);
    if (!branch || !text(run.id)) return undefined;
    return { ...base, kind: "ci-failed", branch, workflow, id: `github:run:${text(run.id)}:${text(run.run_attempt) || "1"}`,
      summary: `Workflow “${workflow.slice(0, 120)}” failed on ${branch}`,
      ...(text(run.html_url) ? { url: text(run.html_url) } : {}) };
  }
  return undefined;
}

/**
 * Whether a Space's GitHub connection, as one of its members, still includes
 * the installation an event came from. Asked once per Space and member for
 * the event; a connection that cannot be read does not hear it.
 */
function githubSpaceConnected(env: Env, event: GitHubOutsideEvent): SpaceConnected {
  const connected = new Map<string, Promise<boolean>>();
  return (spaceId, userId) => {
    const key = `${spaceId}\u0000${userId}`;
    if (!connected.has(key)) connected.set(key, (async () => {
      const connection = await findAppConnection(env, { spaceId, providerId: "github", actorUserId: userId });
      const [owner, repo] = event.repository.split("/") as [string, string];
      // Only what the installation's linking administrator administers now is heard in the Space.
      return connection?.status === "configured" &&
        await githubRepositoryDelegated(env, connection, event.installationId, owner, repo);
    })().catch(() => false));
    return connected.get(key)!;
  };
}

const inWords = (event: { summary: string; url?: string }): string =>
  event.url ? `${event.summary} (${event.url})` : event.summary;

/** A GitHub webhook arrived. */
export async function githubEventArrived(env: Env, event: string, payload: Record<string, unknown>): Promise<void> {
  const arrived = githubOutsideEvent(event, payload);
  // A program's GitHub streams are about a repository's default branch.
  if (!arrived || arrived.branch !== arrived.defaultBranch) return;
  const spaceConnected = githubSpaceConnected(env, arrived);
  await occurNornEvent(env, { what: inWords(arrived), matches: githubStream(arrived.kind, arrived.repository),
    allowed: (program) => spaceConnected(program.spaceId, program.authorityUserId) });
}

/** A connector delivered an event for a connection, which its ingress already authenticated the delivery to. */
export async function connectorEventArrived(env: Env, input: ConnectorOutsideEvent): Promise<void> {
  // Mail is one member's: an event that names no member is heard by nobody.
  if (input.provider === "gmail" && !input.authorizedUserId) return;
  await occurNornEvent(env, { spaceId: input.spaceId, what: inWords(input.event),
    matches: appStream(input.provider, input.event.feature),
    allowed: async (program) => !input.authorizedUserId || program.authorityUserId === input.authorizedUserId });
}
