/**
 * Dispatch-owned scheduled Run/Instance cleanup.
 *
 * Separate boundary from SQL occurrence lifecycle storage. Free functions and
 * consumers take ScheduledRunCleanup only. RelayAuthority constructs
 * ScheduledRunCleanupCollaborator once.
 */
import type { AutomationOccurrenceRow } from "./automation-occurrence-rows";

/**
 * Consumer-facing cleanup API for dispatch orchestration.
 * Timeout reaper does not own this boundary.
 */
export interface ScheduledRunCleanup {
  abandon(
    occurrence: AutomationOccurrenceRow,
    reason: string,
  ): Promise<void>;
}

