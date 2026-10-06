import { appendChannelMessage } from "./channel-messages";
import { PostgresScheduleOccurrenceLifecycle } from "./postgres-automation-authority";
import { PostgresScheduledRunCleanup } from "./postgres-scheduled-run-cleanup";
import { dispatchProductMessagePostCommit } from "./product-message-post-commit";
import { AUTOMATION_OCCURRENCE_BATCH_SIZE } from "./automation-occurrence-rows";
import {
  dispatchScheduledMessageOccurrence, type ScheduledMessageDelivery,
} from "./relay-authority-scheduled-message-delivery";
import { dispatchScheduledOccurrence } from "./scheduled-occurrence-dispatch";
import { machineDaemonCommand } from "./machines";
import type { Env } from "./types";

/**
 * Serve one Space's due Automation work: stop Runs past their deadline, then
 * claim and dispatch a bounded batch of due occurrences. Every effect is a
 * PostgreSQL write or a Hub product command; nothing here holds Space state.
 */
export async function runSpaceAutomationAlarm(env: Env, spaceId: string, ports: {
  /** Keeps post-commit message interpretation alive after the pass returns. */
  waitUntil(task: Promise<unknown>): void;
}): Promise<{ processed: number }> {
  const schedule = new PostgresScheduleOccurrenceLifecycle(env, undefined, { spaceId });
  await reapSpaceAutomationRuns(env, new Date(), schedule);
  const runCleanup = new PostgresScheduledRunCleanup(env);
  const messageDelivery: ScheduledMessageDelivery = {
    dispatch: (occurrence, automation, payload, lifecycle) =>
      dispatchScheduledMessageOccurrence({
        appendMessage: (command) => appendChannelMessage(env, command.channelId,
          command as unknown as Record<string, unknown>),
        schedulePostCommit: (input) => ports.waitUntil(dispatchProductMessagePostCommit({
          env, ...input, scheduleBackground: (task) => ports.waitUntil(task),
        })),
      }, occurrence, automation, payload, lifecycle),
  };
  const leaseOwner = `space-automation:${crypto.randomUUID()}`;
  let processed = 0;
  for (; processed < AUTOMATION_OCCURRENCE_BATCH_SIZE; processed += 1) {
    const claimAt = new Date();
    const occurrence = await schedule.claim(claimAt, claimAt.toISOString(), leaseOwner);
    if (!occurrence) break;
    await dispatchScheduledOccurrence({ schedule, runCleanup, messageDelivery }, occurrence, claimAt);
  }
  return { processed };
}

/**
 * Stop the Runs whose execution deadline passed, each through its owner's
 * daemon command, exactly as a spawn goes.
 */
export async function reapSpaceAutomationRuns(env: Env, nowDate: Date,
  schedule: Pick<PostgresScheduleOccurrenceLifecycle, "reapExpiredRuns">): Promise<void> {
  await schedule.reapExpiredRuns(nowDate, async ({ occurrence, machineId, hostId, executionKey, controlId }) => {
    await machineDaemonCommand(env, {
      commandId: `scheduled:${occurrence.status === "cancelled" ? "cancel-machine-stop" : "machine-stop"}:${occurrence.id}:${occurrence.attempts}`.slice(0, 200),
      action: "issue", controlId, commandType: "stop",
      ownerUserId: occurrence.owner_user_id,
      ownerEmail: `${occurrence.owner_user_id.replace(/[^a-zA-Z0-9._-]/gu, "_")}@unknown.invalid`,
      machineId, hostId,
      payload: { type: "machine_stop_agent", requestId: controlId,
        runId: occurrence.run_id, ...(executionKey ? { executionKey } : {}),
        agentId: occurrence.instance_id, instanceId: occurrence.instance_id,
        reason: "scheduled_execution_timeout", worktreeDisposition: "retain" },
      metadata: { source: "automation_timeout", scheduledTaskId: occurrence.task_id,
        scheduledOccurrenceId: occurrence.id },
      capabilities: [], principal: { kind: "user", id: occurrence.owner_user_id },
    });
  });
}
