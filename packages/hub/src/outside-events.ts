import { githubRepositoryDelegated } from "./app-connectors";
import { findAppConnection } from "./apps";
import { record, text } from "./github-subscription-domain";
import { occurNornEvent } from "./norn-events";
import { appStream, eventsStream, githubStream, type NornStream } from "./norn-host";
import type { Env } from "./types";
import type { CloudEventInput } from "./vendor/norn/runtime/ledger";
import type { Value } from "./vendor/norn/runtime/value";

/**
 * Events arrive from outside the Hub here: a pull request merged into a
 * branch, a workflow failing on it, an issue opened, or a connected app's
 * event. Each reaches the Norn programs that wait on a matching stream — both
 * standard `Events.events(...)` (CloudEvents 1.0.2, used by `GitHub` and
 * `Gmail` libraries) and legacy `ciFailed`/`prMerged`/`appEvent` streams
 * (docs/architecture/norn-host.md, "Events from outside"). A GitHub event is
 * heard only in a Space whose GitHub connection still includes the
 * installation it came from; a connector event only in the Space of the
 * connection its ingress authenticated it to.
 */

interface GitHubOutsideEvent {
  id: string;
  kind: "merged" | "ci-failed" | "issue-opened" | "workflow-completed" | "pull-closed";
  summary: string;
  url?: string;
  repository: string;
  branch: string;
  defaultBranch: string;
  installationId: string;
  workflow?: string;
  conclusion?: string;
  merged?: boolean;
  pullRequest?: number;
  title?: string;
  author?: string;
  issueNumber?: number;
}

/** A connector's event for one connection's Space; `authorizedUserId` keeps it to that member's own work. */
interface ConnectorOutsideEvent {
  spaceId: string;
  provider: string;
  authorizedUserId?: string;
  event: {
    eventId: string;
    sourceRef: string;
    feature: string;
    summary: string;
    url?: string;
    /** Optional structured payload fields for `Events` library filtering (kept inside authorized scope). */
    data?: Record<string, unknown>;
  };
}

/** Whether a member's Space is connected to what an event came from. */
type SpaceConnected = (spaceId: string, userId: string) => Promise<boolean>;

function toNornValue(raw: unknown): Value {
  if (typeof raw === "boolean") return { type: "bool", value: raw };
  if (typeof raw === "number") return Number.isInteger(raw) ? { type: "int", value: String(raw) } : { type: "float", value: String(raw) };
  if (typeof raw === "string") return { type: "string", value: raw };
  if (Array.isArray(raw)) return { type: "list", values: raw.map(toNornValue) };
  if (raw && typeof raw === "object") {
    const fields: Record<string, Value> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v !== undefined) fields[k] = toNornValue(v);
    }
    return { type: "record", fields };
  }
  return { type: "string", value: "" };
}

/** The outside event a GitHub webhook is, if any. */
export function githubOutsideEvent(event: string, payload: Record<string, unknown>): GitHubOutsideEvent | undefined {
  const repository = record(payload.repository);
  const name = text(repository.full_name);
  const installationId = text(record(payload.installation).id);
  if (!name || !installationId) return undefined;
  const base = { repository: name, defaultBranch: text(repository.default_branch) || "main", installationId };
  if (event === "pull_request" && payload.action === "closed") {
    const pull = record(payload.pull_request);
    const number = Number(pull.number);
    const branch = text(record(pull.base).ref);
    const title = text(pull.title).slice(0, 120);
    const merged = pull.merged === true;
    if (!Number.isSafeInteger(number) || !branch) return undefined;
    return {
      ...base,
      kind: merged ? "merged" : "pull-closed",
      branch,
      pullRequest: number,
      merged,
      ...(title ? { title } : {}),
      id: `github:${name}#${number}:${merged ? "merged" : "closed"}`,
      summary: merged ? `Pull request #${number} “${title}” was merged into ${branch}` : `Pull request #${number} “${title}” was closed on ${branch}`,
      ...(text(pull.html_url) ? { url: text(pull.html_url) } : {}),
    };
  }
  if (event === "workflow_run" && payload.action === "completed") {
    const run = record(payload.workflow_run);
    const branch = text(run.head_branch);
    const workflow = text(run.name);
    const conclusion = text(run.conclusion) || "unknown";
    if (!branch || !text(run.id)) return undefined;
    const failed = conclusion === "failure";
    return {
      ...base,
      kind: failed ? "ci-failed" : "workflow-completed",
      branch,
      workflow,
      conclusion,
      id: `github:run:${text(run.id)}:${text(run.run_attempt) || "1"}`,
      summary: failed ? `Workflow “${workflow.slice(0, 120)}” failed on ${branch}` : `Workflow “${workflow.slice(0, 120)}” completed (${conclusion}) on ${branch}`,
      ...(text(run.html_url) ? { url: text(run.html_url) } : {}),
    };
  }
  if (event === "issues" && payload.action === "opened") {
    const issue = record(payload.issue);
    const number = Number(issue.number);
    const title = text(issue.title).slice(0, 120);
    if (!Number.isSafeInteger(number) || !title) return undefined;
    const author = text(record(issue.user).login);
    return { ...base, kind: "issue-opened", branch: base.defaultBranch, issueNumber: number, title, author,
      id: `github:${name}#${number}:opened`,
      summary: `Issue #${number} “${title}” was opened`,
      ...(text(issue.html_url) ? { url: text(issue.html_url) } : {}) };
  }
  return undefined;
}

function githubCloudEvent(arrived: GitHubOutsideEvent): CloudEventInput {
  if (arrived.kind === "issue-opened") {
    return {
      app: "github",
      kind: "issues.opened",
      source: arrived.repository,
      id: arrived.id,
      data: toNornValue({
        number: arrived.issueNumber ?? 0,
        title: arrived.title ?? arrived.summary,
        author: arrived.author ?? "",
        url: arrived.url ?? "",
      }),
    };
  }
  if (arrived.kind === "ci-failed" || arrived.kind === "workflow-completed") {
    return {
      app: "github",
      kind: "workflow_run.completed",
      source: arrived.repository,
      id: arrived.id,
      data: toNornValue({
        workflow: arrived.workflow ?? "",
        conclusion: arrived.conclusion ?? (arrived.kind === "ci-failed" ? "failure" : "unknown"),
        branch: arrived.branch,
        defaultBranch: arrived.defaultBranch,
        url: arrived.url ?? "",
      }),
    };
  }
  return {
    app: "github",
    kind: "pull_request.closed",
    source: arrived.repository,
    id: arrived.id,
    data: toNornValue({
      number: arrived.pullRequest ?? 0,
      title: arrived.title ?? arrived.summary,
      merged: arrived.merged ?? arrived.kind === "merged",
      branch: arrived.branch,
      defaultBranch: arrived.defaultBranch,
      url: arrived.url ?? "",
    }),
  };
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
  if (!arrived) return;
  const spaceConnected = githubSpaceConnected(env, arrived);
  const cloudEvent = githubCloudEvent(arrived);
  const matchEvents = eventsStream ? eventsStream(cloudEvent.app, cloudEvent.kind, cloudEvent.source) : () => false;
  // Legacy `ciFailed`/`prMerged` streams remain strictly gated to failed CI / merged PRs on the default branch.
  const isLegacyMatchable = (arrived.kind === "ci-failed" || arrived.kind === "merged") && arrived.branch === arrived.defaultBranch;
  const matchLegacy = isLegacyMatchable ? githubStream(arrived.kind as "ci-failed" | "merged", arrived.repository) : () => false;
  const matches = (stream: NornStream): boolean => matchLegacy(stream) || matchEvents(stream);
  await occurNornEvent(env, { id: arrived.id, what: inWords(arrived), cloudEvent, matches,
    grant: { kind: "github", repository: arrived.repository, installationId: arrived.installationId },
    allowed: (program) => spaceConnected(program.spaceId, program.authorityUserId) });
}

/** A connector delivered an event for a connection, which its ingress already authenticated the delivery to. */
export async function connectorEventArrived(env: Env, input: ConnectorOutsideEvent): Promise<void> {
  // Mail is one member's: an event that names no member is heard by nobody.
  if (input.provider === "gmail" && !input.authorizedUserId) return;
  const cloudEvent: CloudEventInput = {
    app: input.provider,
    kind: input.event.feature,
    source: input.event.sourceRef,
    id: input.event.eventId,
    data: toNornValue(input.event.data ?? {
      summary: input.event.summary,
      ...(input.event.url ? { url: input.event.url } : {}),
    }),
  };
  const matchLegacy = appStream(input.provider, input.event.feature);
  const matchEvents = eventsStream ? eventsStream(cloudEvent.app, cloudEvent.kind, cloudEvent.source) : () => false;
  const matches = (stream: NornStream): boolean => matchLegacy(stream) || matchEvents(stream);
  await occurNornEvent(env, { id: JSON.stringify(["connector", input.provider, input.event.eventId]),
    spaceId: input.spaceId, what: inWords(input.event), cloudEvent, matches,
    grant: { kind: "connector", provider: input.provider,
      ...(input.authorizedUserId ? { authorizedUserId: input.authorizedUserId } : {}) },
    allowed: async (program) => !input.authorizedUserId || program.authorityUserId === input.authorizedUserId });
}
