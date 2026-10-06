import type { AuthorityDatabase } from "@xmatrix/db";
import { wakeAgentLaunchChannel } from "./agent-launch-coordinator-wake";
import { ACTIVE_RUN_STATUS_SQL } from "@xmatrix/protocol";

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
  database: AuthorityDatabase, scope: { spaceId: string } | { ownerUserId: string; machineId: string }): Promise<number> {
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
    wakeAgentLaunchChannel(env.RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL, { channelId: String(row.channel_id) })));
  if (woken.some(result => result.status === "rejected" || !result.value.ok)) {
    throw new Error("A Channel affected by this authority change could not be told");
  }
  return rows.length;
}
