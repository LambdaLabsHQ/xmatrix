import { parseAgentStopCommand } from "@xmatrix/protocol";

export interface ProductAgentKillTarget {
  instanceId: string;
  runId: string;
  agentId: string;
  mentionTarget: string;
  ownerUserId: string;
  machineOwnerUserId: string;
  machineId: string;
  hostId: string;
  executionKey?: string;
  resumeSessionKey?: string;
  repoPool?: { repoIdentity: string; repoKeyId: string; slotId: string };
  /** Set when a `/kill all` already fenced this Run in its message append. */
  stopRequestSourceMessageId?: string;
}

/** Push the stopped Run's whole checkout to `branch` (docs/same-machine-instance-handoff.md §2.1). */
export interface ProductAgentHandoffExport {
  branch: string;
  channelId: string;
}

export interface ProductAgentHandoffSource {
  instanceId: string;
  runId: string;
}

export interface ProductAgentInterventionPort {
  /** A handoff also stops an exited source's rest, so it cannot wake again. */
  listKillTargets(channelId: string, handoffSource?: ProductAgentHandoffSource): Promise<ProductAgentKillTarget[]>;
  issueStop(
    target: ProductAgentKillTarget,
    controlId: string,
    reason: string,
    channelId?: string,
    waitForTermination?: boolean,
  ): Promise<void>;
  /**
   * Stop the target so its daemon carries its checkout to a handoff branch,
   * and wait up to `timeoutMs` for the daemon's report. `handoffExport` is the
   * daemon's export outcome; a daemon that predates exports reports none.
   */
  issueHandoffStop?(
    target: ProductAgentKillTarget,
    controlId: string,
    reason: string,
    channelId: string,
    handoffExport: ProductAgentHandoffExport,
    timeoutMs: number,
  ): Promise<{ stopped: boolean; handoffExport?: Record<string, unknown> }>;
  /**
   * Whether the target's machine daemon is online to receive a stop now;
   * `undefined` when that could not be read. A stop to an offline daemon
   * stays queued and only applies once the daemon reconnects.
   */
  daemonOnline?(target: ProductAgentKillTarget): Promise<boolean | undefined>;
  /** `key` distinguishes this command's notices; each key posts at most once. */
  publishSystemNotice(channelId: string, body: string, key?: "host-cleanup"): Promise<void>;
  /**
   * Stop resting Instances, which have no process to terminate: they simply
   * stop waking (docs/instance-sleep.md §4). `mention` selects one
   * `name:ordinal`; without it every resting Instance not in `exclude` stops.
   */
  stopResting?(channelId: string, target: { mention?: string; exclude: readonly string[] }):
    Promise<Array<{ instanceId: string; mentionTarget: string }>>;
}

export interface ProductAgentInterventionResult {
  considered: number;
  stopped: number;
  failures: string[];
  pending?: number;
}

/** The exact stop was queued, but host termination is not confirmed yet. */
export class AgentStopPendingError extends Error {}

export const parseProductAgentStopCommand = parseAgentStopCommand;

/** A stop queued for an offline daemon has not happened yet; say so rather
 * than report it as done. The daemon's own stop result posts when it applies. */
function queuedForOfflineDaemon(mentionTargets: readonly string[]): string {
  return mentionTargets.length === 1
    ? `Stop queued for @${mentionTargets[0]}. Its machine's daemon is offline, so the process keeps running ` +
      "until the daemon reconnects and applies the stop."
    : `Stop queued for ${mentionTargets.map((name) => `@${name}`).join(", ")}. Their machines' daemons are offline, ` +
      "so those processes keep running until the daemons reconnect and apply the stop.";
}

async function offlineTargets(port: ProductAgentInterventionPort,
  targets: readonly ProductAgentKillTarget[]): Promise<Set<string>> {
  if (!port.daemonOnline || targets.length === 0) return new Set();
  // One read per daemon, not per Instance.
  const daemons = new Map<string, ProductAgentKillTarget[]>();
  for (const target of targets) {
    const key = JSON.stringify([target.machineOwnerUserId, target.machineId]);
    daemons.set(key, [...daemons.get(key) ?? [], target]);
  }
  const offline = new Set<string>();
  await Promise.all([...daemons.values()].map(async (group) => {
    // An unreadable status keeps the ordinary wording rather than guessing.
    const online = await port.daemonOnline!(group[0]!).catch(() => undefined);
    if (online === false) for (const target of group) offline.add(target.instanceId);
  }));
  return offline;
}

export async function orchestrateProductAgentIntervention(input: {
  channelId: string;
  sourceMessageId: string;
  body: string;
  port: ProductAgentInterventionPort;
}): Promise<ProductAgentInterventionResult> {
  const command = parseProductAgentStopCommand(input.body);
  if (!command) return { considered: 0, stopped: 0, failures: [] };

  let targets: ProductAgentKillTarget[];
  try {
    targets = await input.port.listKillTargets(input.channelId);
  } catch (error) {
    try {
      await input.port.publishSystemNotice(
        input.channelId,
        "xMatrix could not resolve live Agent Instances. No stop request was issued.",
      );
    } catch {
      // Preserve the authority failure that prevented the stop. The caller logs
      // it with Channel/message coordinates; notice delivery is best-effort.
    }
    throw error;
  }
  const normalizedTarget = command.target.toLowerCase();
  const selected = command.all
    ? targets
    : targets.filter((target) => target.mentionTarget.toLowerCase() === normalizedTarget
      || `${target.agentId}${/:\d+$/u.exec(target.mentionTarget)?.[0] || ""}`.toLowerCase() === normalizedTarget);
  const failures: string[] = [];
  const pending: string[] = [];
  let stopped = 0;

  if (!command.all && selected.length > 1) {
    await input.port.publishSystemNotice(input.channelId,
      "More than one Agent matches this name. Select the owner and machine before stopping an Instance.");
    return { considered: 1, stopped: 0, failures: ["ambiguous_agent_name"] };
  }

  if (!command.all && selected.length === 0) {
    const resting = await input.port.stopResting?.(input.channelId, { mention: command.target, exclude: [] }) ?? [];
    if (resting.length > 0) {
      await input.port.publishSystemNotice(input.channelId,
        `Stopped @${resting[0]!.mentionTarget}. It was resting and will no longer wake for new messages.`);
      return { considered: 1, stopped: resting.length, failures: [] };
    }
    const notice = `xMatrix could not find a live instance for \`@${command.target}\`.`;
    await input.port.publishSystemNotice(input.channelId, notice);
    return { considered: 1, stopped: 0, failures: [] };
  }
  // `/kill all` also ends every resting Instance's rest; a live target is
  // stopped through its daemon instead, even while it is waking.
  const restingStopped = command.all
    ? (await input.port.stopResting?.(input.channelId, { exclude: targets.map((target) => target.instanceId) }) ?? []).length
    : 0;
  const restingSummary = restingStopped > 0
    ? `Stopped ${restingStopped} resting agent instance${restingStopped === 1 ? "" : "s"}.`
    : "";

  // A fenced Run can no longer act in Hub, but its process may still be alive.
  const fenced = selected.length > 0 &&
    selected.every((target) => target.stopRequestSourceMessageId !== undefined);
  // A route being online is not host termination evidence.
  const offline = fenced || !command.all ? await offlineTargets(input.port, selected) : new Set<string>();
  const queued = selected.filter((target) => offline.has(target.instanceId)).map((target) => target.mentionTarget);
  if (fenced) {
    // "Stop requested" is the chip on the command. A notice is only for what
    // that chip cannot see yet: an offline daemon, or resting Instances.
    const note = [queued.length > 0 ? queuedForOfflineDaemon(queued) : "", restingSummary].filter(Boolean).join(" ");
    if (note) await input.port.publishSystemNotice(input.channelId, note);
  }

  await Promise.all(selected.map(async (target) => {
    const stable = `${input.sourceMessageId}:${target.instanceId}`;
    try {
      await input.port.issueStop(
        target,
        `${command.all ? "kill-all" : "stop"}:${stable}`.slice(0, 200),
        command.reason || (command.all ? "Stopped by /kill all" : "Stopped from xMatrix web"),
        input.channelId,
        // A fenced stop is already in effect; its host result finalizes the Run
        // through the terminal report, so the command only has to be durable.
        command.all && !fenced,
      );
      stopped += 1;
    } catch (error) {
      if (error instanceof AgentStopPendingError) pending.push(target.mentionTarget);
      else failures.push(
        `${target.instanceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }));

  if (fenced) {
    const cleanup = [
      pending.length > 0
        ? `Host cleanup is still pending for ${pending.join(", ")}.`
        : "",
      failures.length > 0
        ? `Host cleanup failed for ${failures.length}: ${failures.join("; ")}.`
        : "",
    ].filter(Boolean).join(" ");
    if (cleanup) await input.port.publishSystemNotice(input.channelId, cleanup, "host-cleanup");
    return { considered: selected.length, stopped, failures,
      ...(pending.length ? { pending: pending.length } : {}) };
  }

  // Accepted and confirmed stops stay on the command's chip. The message is
  // for a queue, a resting Instance, a host that has not answered, or a failure.
  const summary = [
    queued.length > 0 ? queuedForOfflineDaemon(queued) : "",
    restingSummary,
    pending.length > 0
      ? `Waiting for host confirmation for ${pending.length} agent instance${pending.length === 1 ? "" : "s"}.`
      : "",
    failures.length > 0
      ? `Failed ${failures.length}: ${failures.join("; ")}.`
      : "",
  ].filter(Boolean).join(" ") || (selected.length === 0 ? "No live agent instances to stop in this channel." : "");
  if (summary) await input.port.publishSystemNotice(input.channelId, summary);
  return { considered: selected.length, stopped, failures,
    ...(pending.length ? { pending: pending.length } : {}) };
}
