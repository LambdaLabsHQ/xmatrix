import { plainRecord as record } from "./plain-record.js";

/**
 * Automation names shared by the Hub and its authorities, stored and on the
 * wire. Contract migration 0081 rewrote every pre-rename stored value, and the
 * Hub sends only the automation spelling: command kinds `automation_put` /
 * `automation_remove`, `automationId`, and `automation_*` audit action types.
 * Inventory: docs/operations/automation-stored-values-inventory.md.
 */

/** Shortest cadence an Automation may store, in minutes. */
export const AUTOMATION_MIN_INTERVAL_MINUTES = 15;
/** Longest cadence an Automation may store: 30 days, in minutes. */
export const AUTOMATION_MAX_INTERVAL_MINUTES = 30 * 24 * 60;

/** A whole number of minutes inside the stored Automation cadence bounds. */
export function isAutomationIntervalMinutes(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= AUTOMATION_MIN_INTERVAL_MINUTES
    && value <= AUTOMATION_MAX_INTERVAL_MINUTES;
}

/** management_actions.action_type for Automation governance rows. */
export type AutomationActionType =
  | "automation_update"
  | "automation_pause"
  | "automation_resume"
  | "automation_delete";

export interface AutomationRunIdentity {
  automationId?: string;
  automationName?: string;
  automationOccurrenceId?: string;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The Automation that started a Run, read from its Run metadata. */
export function automationRunIdentity(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): AutomationRunIdentity {
  if (!metadata) return {};
  const automationId = nonempty(metadata.automationId);
  const automationName = nonempty(metadata.automationName);
  const automationOccurrenceId = nonempty(metadata.automationOccurrenceId);
  return {
    ...(automationId ? { automationId } : {}),
    ...(automationName ? { automationName } : {}),
    ...(automationOccurrenceId ? { automationOccurrenceId } : {}),
  };
}

/** Lineage root / expression ref for an Automation: `automation:<id>`. */
export function automationRef(automationId: string): string {
  return `automation:${automationId}`;
}

/*
 * Replay compatibility for the command rename. Remove this section once the
 * replay rows written before the rename have expired (30-day TTL after the
 * rename ships).
 *
 * Hubs before the rename sent `scheduled_task_put` / `scheduled_task_remove`,
 * `taskId` and `scheduled_task_*` audit types, and every authority stored the
 * digest of exactly that body. An authority therefore canonicalizes each
 * incoming body before digesting it, stores the canonical digest, and also
 * accepts a stored digest of the legacy view, so a retry that straddles the
 * deploy replays instead of conflicting.
 */

const LEGACY_COMMAND_KINDS: Readonly<Record<string, string>> = {
  scheduled_task_put: "automation_put",
  scheduled_task_remove: "automation_remove",
};
const LEGACY_AUDIT_ACTION_TYPES: Readonly<Record<string, AutomationActionType>> = {
  scheduled_task_update: "automation_update",
  scheduled_task_pause: "automation_pause",
  scheduled_task_resume: "automation_resume",
  scheduled_task_delete: "automation_delete",
};
const AUTOMATION_ID_COMMAND_KINDS: ReadonlySet<string> = new Set([
  "automation_put", "automation_remove", "scheduled_execution_cancel",
]);

function inverse(map: Readonly<Record<string, string>>, value: string): string {
  return Object.entries(map).find(([, current]) => current === value)?.[0] ?? value;
}

function withAuditActionType(
  command: Record<string, unknown>, map: (actionType: string) => string,
): Record<string, unknown> {
  const audit = record(command.managementAudit);
  if (!audit || typeof audit.actionType !== "string") return command;
  return { ...command, managementAudit: { ...audit, actionType: map(audit.actionType) } };
}

/** An Automation command body in the current spelling, from either spelling. */
export function canonicalAutomationCommand<T extends Record<string, unknown>>(input: T): T {
  const kind = typeof input.kind === "string"
    ? LEGACY_COMMAND_KINDS[input.kind] ?? input.kind : input.kind;
  if (typeof kind !== "string" || !AUTOMATION_ID_COMMAND_KINDS.has(kind)) return input;
  const { taskId, ...rest } = input as Record<string, unknown>;
  return withAuditActionType({
    ...rest, kind,
    ...(taskId !== undefined && rest.automationId === undefined ? { automationId: taskId } : {}),
  }, (actionType) => LEGACY_AUDIT_ACTION_TYPES[actionType] ?? actionType) as T;
}

/** The body a pre-rename Hub sent for this canonical command (digest comparison only). */
export function legacyAutomationCommandView(command: Record<string, unknown>): Record<string, unknown> {
  if (typeof command.kind !== "string" || !AUTOMATION_ID_COMMAND_KINDS.has(command.kind)) return command;
  const { automationId, ...rest } = command;
  return withAuditActionType({
    ...rest, kind: inverse(LEGACY_COMMAND_KINDS, command.kind),
    ...(automationId !== undefined ? { taskId: automationId } : {}),
  }, (actionType) => inverse(LEGACY_AUDIT_ACTION_TYPES, actionType));
}

/** The command kind a pre-rename Hub used for this canonical kind. */
export function legacyAutomationCommandKind(kind: string): string {
  return inverse(LEGACY_COMMAND_KINDS, kind);
}
