/**
 * What a Run's metadata says about the Automation that started it. Automations
 * no longer run, but Runs they started keep this metadata.
 */

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
