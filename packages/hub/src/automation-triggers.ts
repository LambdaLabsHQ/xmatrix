import { PostgresAutomationRepository, PostgresPageRepository } from "@xmatrix/db";
import { automationReferences, type AutomationTrigger } from "@xmatrix/protocol";
import { githubConnectionHasInstallation, githubPullRequestPaths } from "./app-connectors";
import { record, text } from "./github-subscription-domain";
import { tellPageAutomationChannels } from "./page-automation-wake";
import { createPostgresAuthorityDatabase, createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import type { Env } from "./types";
import { findAppConnection } from "./apps";

/**
 * Events fire a page's Automations (docs/design/pages-live-document.md §6.2):
 * a pull request merged into a branch, a workflow failing on it, a section
 * starting to owe an update. Firing makes the next occurrence due now and
 * records the event for it; events coalesce. A GitHub event fires only
 * Automations whose trigger recorded the installation it came from and whose
 * Space's GitHub connection still includes that installation.
 */

interface FiredEvent { id: string; kind: AutomationTrigger["kind"]; summary: string; url?: string }

interface GitHubEvent extends FiredEvent {
  kind: "merged" | "ci-failed";
  repository: string;
  branch: string;
  defaultBranch: string;
  installationId: string;
  workflow?: string;
  pullRequest?: number;
}

/** The trigger event a GitHub webhook is, if any. */
export function githubTriggerEvent(event: string, payload: Record<string, unknown>): GitHubEvent | undefined {
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

function underPath(path: string, prefix: string): boolean {
  const clean = prefix.replace(/^\/+/u, "");
  return path === clean || path.startsWith(clean.endsWith("/") ? clean : `${clean}/`);
}

function fleet(env: Env) {
  return createPostgresAuthorityFleet(env, { applicationName: "xmatrix-automation-triggers",
    statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000 });
}

/** Fires every page Automation a GitHub webhook concerns; returns how many it fired. */
export async function fireGitHubAutomationTriggers(env: Env, event: string,
  payload: Record<string, unknown>): Promise<number> {
  const fired = githubTriggerEvent(event, payload);
  if (!fired) return 0;
  let changedPaths: Promise<string[]> | undefined;
  const paths = () => changedPaths ??= githubPullRequestPaths(env, fired.installationId,
    ...(fired.repository.split("/") as [string, string]), fired.pullRequest!);
  const connected = new Map<string, Promise<boolean>>();
  const spaceConnected = (spaceId: string, userId: string) => {
    const key = `${spaceId}\u0000${userId}`;
    if (!connected.has(key)) connected.set(key, (async () => {
      const connection = await findAppConnection(env, { spaceId, providerId: "github", actorUserId: userId });
      return connection?.status === "configured" && githubConnectionHasInstallation(connection, fired.installationId);
    })().catch(() => false));
    return connected.get(key)!;
  };
  return fireAcrossShards(env, { trigger: { kind: fired.kind, repository: fired.repository } }, async (candidate) => {
    let matches = false;
    for (const trigger of candidate.triggers as AutomationTrigger[]) {
      if (trigger.kind !== fired.kind || trigger.repository !== fired.repository ||
          trigger.installationId !== fired.installationId || (trigger.branch ?? fired.defaultBranch) !== fired.branch) {
        continue;
      }
      if (trigger.kind === "ci-failed" && trigger.workflow && trigger.workflow !== fired.workflow) continue;
      if (trigger.kind === "merged" && trigger.paths?.length &&
          !(await paths()).some((path) => trigger.paths!.some((prefix) => underPath(path, prefix)))) continue;
      matches = true;
      break;
    }
    return matches && await spaceConnected(candidate.spaceId, candidate.authorityRootUserId) ? fired : undefined;
  });
}

type TriggerCandidate = Awaited<ReturnType<PostgresAutomationRepository["triggeredBy"]>>[number];

/* Every shard's Automations a trigger query finds, fired with the event the
   caller decides each one takes; the conversations they run in are told. */
async function fireAcrossShards(env: Env, query: Omit<Parameters<PostgresAutomationRepository["triggeredBy"]>[0],
  "requestId">, eventFor: (candidate: TriggerCandidate) => Promise<FiredEvent | undefined>): Promise<number> {
  const channels: string[] = [];
  for (const shard of fleet(env).physicalShards) {
    const repository = new PostgresAutomationRepository(shard.database);
    for (const candidate of await repository.triggeredBy({ requestId: crypto.randomUUID(), ...query })) {
      const event = await eventFor(candidate);
      if (!event) continue;
      const channel = await repository.fireTrigger({ requestId: crypto.randomUUID(), automationId: candidate.automationId,
        eventId: event.id, event: { kind: event.kind, summary: event.summary, ...(event.url ? { url: event.url } : {}) },
        at: new Date().toISOString() });
      if (channel) channels.push(channel);
    }
  }
  await tellPageAutomationChannels(env, channels);
  return channels.length;
}

/** Whether an event trigger concerns a connector event (connector-platform.md §3.4). */
export function connectorTriggerMatches(trigger: AutomationTrigger, event: { provider: string; source: string;
  feature: string }): boolean {
  return trigger.kind === "event" && trigger.provider === event.provider &&
    (trigger.source === "*" || trigger.source === event.source) && (!trigger.feature || trigger.feature === event.feature);
}

/**
 * A connector delivered an event for a connection: fires the Automations in
 * that connection's Space whose event trigger concerns it. The ingress already
 * authenticated the delivery to the connection, so no further check is needed.
 */
export async function fireConnectorAutomationTriggers(env: Env, input: { spaceId: string; provider: string;
  event: { eventId: string; sourceRef: string; feature: string; summary: string; url?: string } }): Promise<number> {
  const source = input.event.sourceRef.slice(input.provider.length + 1);
  const fired: FiredEvent = { id: `${input.provider}:${input.event.eventId}`.slice(0, 200), kind: "event",
    summary: input.event.summary, ...(input.event.url ? { url: input.event.url } : {}) };
  return fireAcrossShards(env, { trigger: { kind: "event", provider: input.provider }, spaceId: input.spaceId },
    async (candidate) => (candidate.triggers as AutomationTrigger[]).some((trigger) => connectorTriggerMatches(trigger,
      { provider: input.provider, source, feature: input.event.feature })) ? fired : undefined);
}

/**
 * Sections of a page started to owe an update (§5.2): fires the page's
 * Automations with an `owed` trigger whose reference is in one of them.
 */
export async function fireOwedAutomationTriggers(env: Env, input: { spaceId: string; pageId: string;
  blockIds: readonly string[]; event: FiredEvent }): Promise<number> {
  const blocks = new Set(input.blockIds);
  const pages = new PostgresPageRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-automation-triggers", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000 }));
  // Its section is where the page references it, read as its author.
  const bodies = new Map<string, Promise<string>>();
  const body = (userId: string) => {
    if (!bodies.has(userId)) bodies.set(userId, pages.read({ requestId: crypto.randomUUID(), spaceId: input.spaceId,
      pageId: input.pageId, principal: { kind: "user", id: userId } }).then(({ page }) => page.body, () => ""));
    return bodies.get(userId)!;
  };
  return fireAcrossShards(env, { trigger: { kind: "owed" }, spaceId: input.spaceId, pageId: input.pageId },
    async (candidate) => {
      const section = automationReferences(await body(candidate.authorityRootUserId)).get(candidate.automationId);
      return section !== undefined && blocks.has(section) ? { ...input.event, kind: "owed" } : undefined;
    });
}
