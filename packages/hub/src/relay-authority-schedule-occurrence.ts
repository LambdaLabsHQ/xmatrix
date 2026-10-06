/**
 * Schedule-occurrence domain: materialize / claim / cancel / lease release /
 * prune / quarantine / fail. Owns SQL lifecycle for Automation occurrence rows.
 *
 * Free functions accept ScheduleOccurrenceStoragePort only.
 * Orchestration consumers depend on ScheduleOccurrenceLifecycle only.
 * RelayAuthority constructs ScheduleOccurrenceCollaborator once.
 *
 * Dispatch-owned Run cleanup lives in relay-authority-scheduled-run-cleanup.ts —
 * not on this lifecycle port.
 */
import type { AutomationExecutionRow, AutomationOccurrenceRow } from "./automation-occurrence-rows";

/**
 * Consumer-facing lifecycle API for Automation alarm/dispatch orchestration.
 * SQL occurrence lifecycle only — no Run/Instance transition authority.
 * Does not expose storage or concrete collaborator type.
 */
export interface ScheduleOccurrenceLifecycle {
  maintain(nowDate: Date, now: string): Promise<void>;
  claim(
    nowDate: Date,
    now: string,
    leaseOwner: string,
  ): Promise<AutomationOccurrenceRow | undefined>;
  cancel(
    occurrence: AutomationOccurrenceRow,
    now: string,
    code: string,
    message: string,
  ): Promise<void>;
  fail(
    occurrence: AutomationOccurrenceRow,
    nowDate: Date,
    now: string,
    error: unknown,
    permanent: boolean,
  ): Promise<void>;
  getAutomation(automationId: string): Promise<AutomationExecutionRow | undefined>;
  markPrepared(occurrence: AutomationOccurrenceRow, now: string): Promise<void>;
  markDispatched(
    occurrence: AutomationOccurrenceRow,
    automation: AutomationExecutionRow,
    now: string,
  ): Promise<void>;
  finishMessage(
    occurrence: AutomationOccurrenceRow,
    automation: AutomationExecutionRow,
    now: string,
  ): Promise<void>;
  assertPrepared(input: {
    occurrenceId: string;
    taskId: string;
    leaseOwner: string;
    controlId: string;
    runId: string;
  }): Promise<void>;
  requireEvaluationAuthority(channelId: string, authorityRootUserId: string): Promise<void>;
}

export function automationDatumFromPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const input = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
    ? payload.input as Record<string, unknown> : undefined;
  return input?.datum && typeof input.datum === "object" && !Array.isArray(input.datum)
    ? input.datum as Record<string, unknown>
    : payload.expression && typeof payload.expression === "object" && !Array.isArray(payload.expression)
      ? payload.expression as Record<string, unknown>
    : undefined;
}
