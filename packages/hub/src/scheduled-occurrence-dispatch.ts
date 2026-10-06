import type { AutomationOccurrenceRow } from "./automation-occurrence-rows";

export interface ScheduledOccurrenceDispatchDependencies {
  schedule: import("./relay-authority-schedule-occurrence").ScheduleOccurrenceLifecycle;
  runCleanup: import("./relay-authority-scheduled-run-cleanup").ScheduledRunCleanup;
  messageDelivery: import("./relay-authority-scheduled-message-delivery").ScheduledMessageDelivery;
}

export async function dispatchScheduledOccurrence(
    dependencies: ScheduledOccurrenceDispatchDependencies,
    occurrence: AutomationOccurrenceRow,
    nowDate: Date,
  ): Promise<void> {
    const { schedule, runCleanup, messageDelivery } = dependencies;
    const now = nowDate.toISOString();
    const automation = await schedule.getAutomation(occurrence.task_id);
    if (!automation) {
      await runCleanup.abandon(occurrence, "automation_deleted");
      await schedule.cancel(occurrence, now, "automation_deleted", "Automation was deleted");
      return;
    }
    if (automation.enabled !== 1) {
      await runCleanup.abandon(occurrence, "automation_changed");
      await schedule.cancel(occurrence, now, "automation_changed", "Automation was disabled before dispatch");
      return;
    }
    const payload = JSON.parse(automation.payload_json) as Record<string, unknown>;
    if (occurrence.delivery_kind === "message") {
      try {
        await messageDelivery.dispatch(occurrence, automation, payload, schedule);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const permanent = /payload is incomplete|not found|archived|permission|access/iu.test(message);
        await schedule.fail(
          occurrence,
          nowDate,
          new Date().toISOString(),
          error,
          permanent,
        );
      }
      return;
    }
    // An Automation posts its expression (a registration launch). The retired
    // Profile-bound Agent payload starts nothing.
    await runCleanup.abandon(occurrence, "invalid_task");
    await schedule.fail(
      occurrence,
      nowDate,
      now,
      new Error("Profile-bound Automations are retired; recreate this Automation as an expression"),
      true,
    );
  }
