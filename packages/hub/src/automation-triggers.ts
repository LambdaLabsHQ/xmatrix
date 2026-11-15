import { PostgresAutomationRepository } from "@xmatrix/db";
import type { AutomationTrigger } from "@xmatrix/protocol";
import { githubPullRequestPaths } from "./app-connectors";
import type { ConnectorOutsideEvent, GitHubOutsideEvent, SpaceConnected } from "./outside-events";
import { tellPageAutomationChannels } from "./page-automation-wake";
import { createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import type { Env } from "./types";

/**
 * Events fire a page's Automations (docs/design/pages-live-document.md §6.2):
 * a pull request merged into a branch, a workflow failing on it, a connected
 * app's event. Firing makes the next occurrence due now and
 * records the event for it; events coalesce. A GitHub event fires only
 * Automations whose trigger recorded the installation it came from and whose
 * Space's GitHub connection still includes that installation.
 */

interface FiredEvent { id: string; kind: AutomationTrigger["kind"]; summary: string; url?: string }

function underPath(path: string, prefix: string): boolean {
  const clean = prefix.replace(/^\/+/u, "");
  return path === clean || path.startsWith(clean.endsWith("/") ? clean : `${clean}/`);
}

function fleet(env: Env) {
  return createPostgresAuthorityFleet(env, { applicationName: "xmatrix-automation-triggers",
    statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000 });
}

/** Fires every page Automation a GitHub event concerns; returns how many it fired. */
export async function fireGitHubAutomationTriggers(env: Env, fired: GitHubOutsideEvent,
  spaceConnected: SpaceConnected): Promise<number> {
  let changedPaths: Promise<string[]> | undefined;
  const paths = () => changedPaths ??= githubPullRequestPaths(env, fired.installationId,
    ...(fired.repository.split("/") as [string, string]), fired.pullRequest!);
  // A connected app's event reaches only Automations whose authority may use it now.
  return fireAcrossShards(env, { trigger: { kind: fired.kind, repository: fired.repository }, appUse: true }, async (candidate) => {
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
        at: new Date().toISOString(), ...(query.appUse ? { appUse: true } : {}) });
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
 * that connection's Space whose event trigger concerns it and whose authority
 * may use the Space's connected apps now. The ingress already authenticated
 * the delivery to the connection.
 */
export async function fireConnectorAutomationTriggers(env: Env, input: ConnectorOutsideEvent): Promise<number> {
  if (input.provider === "gmail" && !input.authorizedUserId) return 0;
  const source = input.event.sourceRef.slice(input.provider.length + 1);
  const fired: FiredEvent = { id: `${input.provider}:${input.event.eventId}`.slice(0, 200), kind: "event",
    summary: input.event.summary, ...(input.event.url ? { url: input.event.url } : {}) };
  return fireAcrossShards(env, { trigger: { kind: "event", provider: input.provider }, spaceId: input.spaceId, appUse: true },
    async (candidate) => (!input.authorizedUserId || candidate.authorityRootUserId === input.authorizedUserId) &&
      (candidate.triggers as AutomationTrigger[]).some((trigger) => connectorTriggerMatches(trigger,
      { provider: input.provider, source, feature: input.event.feature })) ? fired : undefined);
}
