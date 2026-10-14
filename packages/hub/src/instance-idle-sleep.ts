import { MachineControlError, type AuthorityDatabase } from "@xmatrix/db";
import { sha256Hex, type AgentRuntimeState, type LiveAgentStatus } from "@xmatrix/protocol";
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
 * Hand a bounded batch of due sleeps to the durable machine command queue.
 * A deadline names one resting period: retries and concurrent passes repeat
 * that exact command, whose existing receipt owns acceptance and delivery.
 * Clear only that deadline, after acceptance, so a failed handoff stays due
 * and a new resting period cannot be erased by an older pass.
 */
export async function reconcileIdleSleeps(env: Env, database: AuthorityDatabase, channelId: string,
  issue: (input: Record<string, unknown>) => Promise<unknown> = (input) => machineDaemonCommand(env, input)): Promise<void> {
  const due = await database.transaction({ requestId: `idle-sleep:${crypto.randomUUID()}`, operation: "runtime.idle-sleep.due" },
    tx => tx.query<QueryResultRow>({ name: "runtime_idle_sleep_due_v2", text: `SELECT
        run.run_id,run.owner_user_id,run.status,run.metadata_json,run.idle_sleep_at::text AS idle_sleep_at,
        instance.instance_id
      FROM data.runs run LEFT JOIN data.instances instance ON instance.run_id=run.run_id
      WHERE run.channel_id=$1 AND run.idle_sleep_at<=clock_timestamp()
      ORDER BY run.idle_sleep_at,run.run_id LIMIT 100`,
    values: [channelId], maxRows: 100 }));
  for (const run of due) {
    const metadata = (run.metadata_json ?? {}) as Record<string, unknown>;
    const machineId = typeof metadata.machineId === "string" ? metadata.machineId : "";
    const executionKey = typeof metadata.executionKey === "string" ? metadata.executionKey : "";
    if (run.status === "running" && run.instance_id && machineId && executionKey) {
      const ownerUserId = String(run.owner_user_id);
      // Keep PostgreSQL's full timestamp precision and long Run ids. The
      // fixed idle threshold also makes retries byte-identical as time passes.
      const controlId = `idle-sleep:${await sha256Hex(JSON.stringify([run.run_id, run.idle_sleep_at]))}`;
      try {
        await issue({
          commandId: controlId, action: "issue", controlId, commandType: "sleep",
          ownerUserId, ownerEmail: `${ownerUserId.replace(/[^a-zA-Z0-9._-]/gu, "_")}@unknown.invalid`,
          machineId, hostId: typeof metadata.hostId === "string" ? metadata.hostId : "", metadata: {}, capabilities: [],
          payload: { type: "machine_sleep_agent", requestId: controlId, runId: String(run.run_id), executionKey,
            instanceId: String(run.instance_id), idleForMillis: INSTANCE_IDLE_SLEEP_MS },
          principal: { kind: "user", id: ownerUserId },
        });
      } catch (error) {
        // Old/offline daemons retain the existing behavior: leave them alone.
        if (!(error instanceof MachineControlError && error.code === "sleep_unavailable")) throw error;
      }
    }
    await database.transaction({ requestId: `idle-sleep:${crypto.randomUUID()}`, operation: "runtime.idle-sleep.accepted" },
      tx => tx.query({ name: "runtime_idle_sleep_clear_v2", text: `UPDATE data.runs SET idle_sleep_at=NULL
        WHERE run_id=$1 AND idle_sleep_at=$2::timestamptz`, values: [run.run_id, run.idle_sleep_at], maxRows: 0 }));
  }
}
