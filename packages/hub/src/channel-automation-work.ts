import { PostgresAutomationRepository, PostgresChannelSpaceDirectory, type AuthorityDatabase } from "@xmatrix/db";

import { wakeAgentLaunchChannel } from "./agent-launch-coordinator-wake";
import { PostgresScheduleOccurrenceLifecycle } from "./postgres-automation-authority";
import { createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import { runSpaceAutomationAlarm } from "./space-automation-alarm";
import type { Env } from "./types";

type AutomationChannelEnv = Pick<Env, "RELAY_AUTOMATION_EXECUTION_ENABLED">;

function automationRuns(env: AutomationChannelEnv): boolean {
  return env.RELAY_AUTOMATION_EXECUTION_ENABLED === "true";
}

/**
 * The Channel's earliest Automation wake: cadence, retry, lease, execution
 * deadline, cleanup and orphan convergence. Undefined when it has none.
 */
export async function channelAutomationDueAt(env: AutomationChannelEnv, database: AuthorityDatabase,
  channelId: string): Promise<number | undefined> {
  if (!automationRuns(env)) return undefined;
  const wakeAt = await new PostgresAutomationRepository(database).nextChannelAutomationWakeAt({
    requestId: `automation:due:${channelId}`.slice(0, 200), channelId });
  const parsed = wakeAt ? Date.parse(wakeAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Service the Channel's due Automation work. Effects stay with the Channel's
 * Space: it claims, dispatches and reaps with every query filtered to that
 * Space. Maintenance can coalesce an occupied cadence into the future, so due
 * cleanup runs first; a second pass serves occurrences that maintenance just
 * materialized.
 */
export async function runChannelAutomation(env: Env, databases: {
  shard: AuthorityDatabase; directory: AuthorityDatabase;
}, channelId: string, waitUntil: (task: Promise<unknown>) => void, nowDate = new Date()): Promise<void> {
  const due = await channelAutomationDueAt(env, databases.shard, channelId);
  if (due === undefined || due > nowDate.getTime()) return;
  const route = await new PostgresChannelSpaceDirectory(databases.directory).resolve({
    requestId: `automation:route:${channelId}`.slice(0, 200), operation: "automation.channel.route",
  }, channelId);
  if (!route) throw new Error("Automation Channel route is unavailable");
  await runSpaceAutomationAlarm(env, route.spaceId, { waitUntil });
  await new PostgresScheduleOccurrenceLifecycle(env).maintain(nowDate, nowDate.toISOString(), route.spaceId);
  await runSpaceAutomationAlarm(env, route.spaceId, { waitUntil });
}

const HANDOVER_PAGE = 200;

/**
 * One page of the cutover to per-Channel Automation timing: wake every Channel
 * that has Automation work, so each coordinator sets its alarm to the
 * Channel's next wake. Pages walk the shards in order; repeat with `next`
 * until it is null. Idempotent: a Channel already timing itself runs one more
 * pass.
 */
export async function handOverAutomationChannels(env: Env, cursor: {
  shardId?: string; afterChannelId?: string;
}): Promise<{ woken: number; failed: number; next: { shardId: string; afterChannelId: string } | null }> {
  const fleet = createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-automation-handover", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  });
  const shards = fleet.physicalShards;
  let index = cursor.shardId ? shards.findIndex((shard) => shard.shardId === cursor.shardId) : 0;
  if (index < 0) throw new Error("Automation handover shard is not configured");
  const shard = shards[index]!;
  const channelIds = await new PostgresAutomationRepository(shard.database).channelsWithAutomationWork({
    requestId: `automation:handover:${shard.shardId}`.slice(0, 200),
    ...(cursor.afterChannelId ? { afterChannelId: cursor.afterChannelId } : {}), limit: HANDOVER_PAGE });
  const woken = await Promise.allSettled(channelIds.map((channelId) =>
    wakeAgentLaunchChannel(env.RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL, { channelId, shardId: shard.shardId })));
  const failed = woken.filter((result) => result.status === "rejected" || !result.value.ok).length;
  const last = channelIds.at(-1);
  if (last && channelIds.length === HANDOVER_PAGE) {
    return { woken: channelIds.length - failed, failed, next: { shardId: shard.shardId, afterChannelId: last } };
  }
  index += 1;
  return { woken: channelIds.length - failed, failed,
    next: index < shards.length ? { shardId: shards[index]!.shardId, afterChannelId: "" } : null };
}
