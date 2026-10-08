import type { AuthorityDatabase } from "@xmatrix/db";
import { AgentLaunchHandoverUnavailable, wakeAgentLaunchChannel } from "./agent-launch-coordinator-wake";
import { createPostgresAuthorityDatabase, type PostgresAuthorityFleetEnv } from "./postgres-authority-fleet";
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
  const woken = await Promise.allSettled(rows.map(row =>
    wakeAgentLaunchChannel(env.RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL, { channelId: String(row.channel_id), work })));
  // The same retryable handover failure as any other coordinator wake: the change is committed
  // and its idempotent retry tells the Channels again.
  const refused = woken.find(result => result.status === "fulfilled" && !result.value.ok);
  if (refused || woken.some(result => result.status === "rejected")) {
    throw new AgentLaunchHandoverUnavailable(refused?.status === "fulfilled" ? refused.value.status : undefined);
  }
  return rows.length;
}

/**
 * A Machine's daemon is back: tell every Channel with a Run on it, so work
 * that waited on the Machine (a queued Launch, a parked stop) moves now
 * rather than at its next timed look, which backs off while the Machine is
 * away.
 */
export async function wakeMachineChannels(env: PostgresAuthorityFleetEnv & {
  RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL?: DurableObjectNamespace }, scope: { ownerUserId: string; machineId: string }): Promise<number> {
  const session = createPostgresAuthorityDatabase(env, { applicationName: "xmatrix-hub-machine-reconnect",
    statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000 }).openSession();
  // Its parked stops can settle, and Launches queued while it was away publish now.
  try { return await wakeRegistrationChannels(env, session, scope, ["registrationStop", "launch"]); }
  finally { await session.close(); }
}
