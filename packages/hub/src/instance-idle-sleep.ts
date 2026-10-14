import { MachineControlError, type AuthorityDatabase } from "@xmatrix/db";
import type { AgentRuntimeState, LiveAgentStatus } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import { machineDaemonCommand } from "./machines";
import type { Env } from "./types";

/**
 * Idle sleep is the Hub's decision (docs/instance-sleep.md): a resumable Run
 * that has rested this long sleeps, and the next message in its Channel wakes
 * it. Its daemon still checks its own facts before it ends the process.
 */
export const INSTANCE_IDLE_SLEEP_MS = 30 * 60 * 1000;

/**
 * Whether an Instance's presence says its Run rests: it is not busy, runs no
 * turn and waits on nothing, so a background watch or a long tool call keeps
 * it awake however quiet it looks.
 */
export function presenceRests(status: LiveAgentStatus | undefined, runtimeState: AgentRuntimeState | undefined): boolean {
  return status !== undefined && status !== "busy" &&
    (!runtimeState || (runtimeState.status !== "running" && !runtimeState.waiting));
}

/**
 * Issue the sleeps that fell due in one Channel. Each due time is taken
 * atomically, so a coordinator pass issues a Run's sleep once; a Run that is
 * no longer running just loses its due time. A daemon that cannot sleep on
 * the Hub's word, or is offline, is left alone and the Run rests on.
 */
export async function reconcileIdleSleeps(env: Env, database: AuthorityDatabase, channelId: string,
  issue: (input: Record<string, unknown>) => Promise<unknown> = (input) => machineDaemonCommand(env, input)): Promise<void> {
  const due = await database.transaction({ requestId: `idle-sleep:${crypto.randomUUID()}`, operation: "runtime.idle-sleep.due" },
    tx => tx.query<QueryResultRow>({ name: "runtime_idle_sleep_take_due_v1", text: `WITH due AS (
        UPDATE data.runs SET idle_sleep_at=NULL
        WHERE channel_id=$1 AND idle_sleep_at<=clock_timestamp()
        RETURNING run_id,owner_user_id,status,metadata_json,idle_sleep_at)
      SELECT due.*,instance.instance_id,
        (EXTRACT(EPOCH FROM clock_timestamp()-due.idle_sleep_at)*1000)::bigint AS overdue_ms
      FROM due LEFT JOIN data.instances instance ON instance.run_id=due.run_id`,
    values: [channelId], maxRows: 100 }));
  for (const run of due) {
    const metadata = (run.metadata_json ?? {}) as Record<string, unknown>;
    const machineId = typeof metadata.machineId === "string" ? metadata.machineId : "";
    const executionKey = typeof metadata.executionKey === "string" ? metadata.executionKey : "";
    if (run.status !== "running" || !run.instance_id || !machineId || !executionKey) continue;
    const ownerUserId = String(run.owner_user_id);
    const controlId = `idle-sleep:${String(run.run_id)}:${new Date(run.idle_sleep_at as Date).getTime()}`.slice(0, 200);
    try {
      await issue({
        commandId: controlId, action: "issue", controlId, commandType: "sleep",
        ownerUserId, ownerEmail: `${ownerUserId.replace(/[^a-zA-Z0-9._-]/gu, "_")}@unknown.invalid`,
        machineId, hostId: typeof metadata.hostId === "string" ? metadata.hostId : "", metadata: {}, capabilities: [],
        payload: { type: "machine_sleep_agent", requestId: controlId, runId: String(run.run_id), executionKey,
          instanceId: String(run.instance_id), idleForMillis: INSTANCE_IDLE_SLEEP_MS + Math.max(0, Number(run.overdue_ms) || 0) },
        principal: { kind: "user", id: ownerUserId },
      });
    } catch (error) {
      if (error instanceof MachineControlError && error.code === "sleep_unavailable") continue;
      throw error;
    }
  }
}
