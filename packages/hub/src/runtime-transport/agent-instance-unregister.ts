import { automationRunIdentity } from "@xmatrix/protocol";

function nonemptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Daemon-launched Runs have a second, host-authenticated terminal report after
 * Agent unregister. Ordinary Agents do not, so their explicit unregister
 * remains terminal.
 */
export function agentInstanceUnregisterIsTerminal(
  runMetadata: Readonly<Record<string, unknown>>,
): boolean {
  const automation = automationRunIdentity(runMetadata);
  return !(
    (automation.automationId !== undefined && automation.automationOccurrenceId !== undefined) ||
    nonemptyString(runMetadata.spawnControlId)
  );
}
