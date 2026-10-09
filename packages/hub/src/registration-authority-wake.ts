import type { AuthorityDatabase } from "@xmatrix/db";
import { AgentLaunchHandoverUnavailable, wakeAgentLaunchChannel } from "./agent-launch-coordinator-wake";
import { createPostgresAuthorityFleet, type PostgresAuthorityFleetEnv } from "./postgres-authority-fleet";
import { ACTIVE_RUN_STATUS_SQL } from "@xmatrix/protocol";
import type { ScheduledStep } from "./postgres-agent-launch-schedule";

/** Channels a committed authority change can affect: those holding a
 *  registration Run that has not ended, bounded like any other page. */
const AFFECTED_CHANNEL_LIMIT = 1_000;

/**
 * An authority change is the event that stops executions it withdraws: after
 * the change commits and before it answers, every Channel with a live
 * registration Run in scope is told, and its coordinator re-checks those Runs
 * against the new authority. A failed wake fails the request; its retry (the
 * same command, an idempotent replay) wakes the same Channels again.
 */
export async function wakeRegistrationChannels(env: { RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL?: DurableObjectNamespace },
  database: AuthorityDatabase, scope: { spaceId: string } | { ownerUserId: string; machineId: string },
  // An authority change is seen only by the registration Runs' re-check.
  work: readonly ScheduledStep[] = ["registrationStop"]): Promise<number> {
  const bySpace = "spaceId" in scope;
  const rows = await database.transaction({ requestId: `registration-authority-wake:${crypto.randomUUID()}`,
    operation: "registration.authority.affected-channels" }, tx => tx.query<{ channel_id: string }>({
    // A machine's Runs span Spaces on every shard; their routes live in the
    // directory this session reads, a Space's Runs on its own shard.
    name: bySpace ? "registration_affected_channels_space_v1" : "registration_affected_channels_machine_v2",
    text: bySpace ? `SELECT DISTINCT run.channel_id FROM data.run_agent_registrations b
      JOIN data.runs run ON run.run_id=b.run_id
      WHERE b.space_id=$1 AND run.status IN (${ACTIVE_RUN_STATUS_SQL}) LIMIT ${AFFECTED_CHANNEL_LIMIT}`
      : `SELECT DISTINCT channel_id FROM data.machine_run_routes
      WHERE owner_user_id=$1 AND machine_id=$2 AND terminal_at IS NULL LIMIT ${AFFECTED_CHANNEL_LIMIT}`,
    values: bySpace ? [scope.spaceId] : [scope.ownerUserId, scope.machineId], maxRows: AFFECTED_CHANNEL_LIMIT }));
  return wakeChannels(env, new Map(rows.map(row => [String(row.channel_id), { work }])));
}

/**
 * A Machine's daemon is back. What waited on it moves now rather than at its
 * next timed look, which backs off while the Machine is away: Launches queued
 * for it and registration stops pending on it. Only their Channels are told,
 * each about that work. A Channel whose Runs merely live on the Machine has
 * nothing to move (2026-10-09: every reconnect woke each such Channel into a
 * full registration re-check, about eight transactions apiece). Each shard is
 * asked once.
 */
export async function wakeMachineChannels(env: PostgresAuthorityFleetEnv & {
  RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL?: DurableObjectNamespace }, scope: { ownerUserId: string; machineId: string },
  shards: readonly { shardId: string; database: AuthorityDatabase }[] = createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-machine-reconnect", statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000,
    lockTimeoutMs: 2_000 }).physicalShards): Promise<number> {
  const waiting = new Map<string, ChannelWork>();
  for (const { shardId, database } of shards) {
    const rows = await database.transaction({ requestId: `machine-reconnect-wake:${crypto.randomUUID()}`,
      operation: "registration.machine.waiting-channels" }, tx => tx.query<{ channel_id: string; work: string }>({
      name: "machine_waiting_channels_v1",
      text: `(SELECT DISTINCT channel_id, 'launch' AS work FROM data.agent_launches
          WHERE owner_user_id=$1 AND machine_id=$2 AND state IN ('prepared','queued') LIMIT ${AFFECTED_CHANNEL_LIMIT})
        UNION ALL (SELECT DISTINCT channel_id, 'registrationStop' AS work FROM data.registration_stop_intents
          WHERE owner_user_id=$1 AND machine_id=$2 AND state='pending' LIMIT ${AFFECTED_CHANNEL_LIMIT})`,
      values: [scope.ownerUserId, scope.machineId], maxRows: 2 * AFFECTED_CHANNEL_LIMIT }));
    for (const row of rows) {
      // The shard is known here, so the Channel need not look it up.
      const channelId = String(row.channel_id);
      waiting.set(channelId, { shardId, work: [...(waiting.get(channelId)?.work ?? []),
        row.work === "launch" ? "launch" : "registrationStop"] });
    }
  }
  return wakeChannels(env, waiting);
}

interface ChannelWork { work: readonly ScheduledStep[]; shardId?: string }

/** Each Channel is told the work named for it. A Channel that cannot be told
 *  fails the caller with the coordinator's retryable handover error: the
 *  change is committed and its idempotent retry tells the Channels again. */
async function wakeChannels(env: { RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL?: DurableObjectNamespace },
  work: ReadonlyMap<string, ChannelWork>): Promise<number> {
  const woken = await Promise.allSettled([...work].map(([channelId, channel]) =>
    wakeAgentLaunchChannel(env.RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL, { channelId, ...channel })));
  const refused = woken.find(result => result.status === "fulfilled" && !result.value.ok);
  if (refused || woken.some(result => result.status === "rejected")) {
    throw new AgentLaunchHandoverUnavailable(refused?.status === "fulfilled" ? refused.value.status : undefined);
  }
  return work.size;
}
