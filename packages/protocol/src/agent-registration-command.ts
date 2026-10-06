import { utf8ByteLength } from "./hex.js";
import { parseSpaceAgentRegistrationKey, type SpaceAgentRegistrationKey } from "./agent-registration.js";
import { parseSpaceAgentConfiguration, spaceConfigurationResources, type SpaceAgentConfiguration } from "./agent-registration-configuration.js";
import { parseRegistrationResourceLimits, type RegistrationResourceLimits } from "./agent-registration-access.js";
import { parseAgentRegistrationEnvironment, type AgentRegistrationEnvironment } from "./agent-registration-environment.js";
import { hasControlCharacter } from "./field-validation.js";

interface Base { key: SpaceAgentRegistrationKey; commandId: string }
export type AgentRegistrationCommand =
  | Base & { action: "offer"; displayName: string }
  /** The owner adds an Agent on their own machine: declare, offer, grant and enable at once. */
  | Base & { action: "create"; displayName: string; environment: AgentRegistrationEnvironment; defaultWorkspace?: string }
  | Base & { action: "configure"; displayName: string; expectedVersion: number; configuration: SpaceAgentConfiguration }
  | Base & { action: "owner-grant"; state: "active" | "revoked"; expectedRevision: number; limits: RegistrationResourceLimits }
  /** A Space owner/admin disables or enables the Agent in this Space. */
  | Base & { action: "space-state"; state: "enabled" | "disabled"; expectedRevision: number };

export function parseAgentRegistrationCommand(value: unknown): AgentRegistrationCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid registration command");
  const row = value as Record<string, unknown>;
  const base = { key: parseSpaceAgentRegistrationKey(row.key), commandId: row.commandId };
  if (typeof base.commandId !== "string" || !base.commandId.trim() || base.commandId !== base.commandId.trim() ||
      utf8ByteLength(base.commandId) > 200 || hasControlCharacter(base.commandId)) {
    throw new Error("Invalid registration command ID");
  }
  const common = { key: base.key, commandId: base.commandId };
  const fields = ["action", "key", "commandId"];
  let result: AgentRegistrationCommand;
  if (row.action === "offer" || row.action === "configure" || row.action === "create") {
    if (typeof row.displayName !== "string" || !row.displayName.trim() ||
        utf8ByteLength(row.displayName) > 80 || hasControlCharacter(row.displayName)) {
      throw new Error("Invalid registration display name");
    }
    fields.push("displayName");
    const named = { ...common, displayName: row.displayName.trim() };
    if (row.action === "offer") result = { ...named, action: row.action };
    else if (row.action === "create") {
      fields.push("environment", "defaultWorkspace");
      const environment = parseAgentRegistrationEnvironment(row.environment);
      if (!environment.launch) throw new Error("A new registration needs its launch");
      if (row.defaultWorkspace !== undefined && (typeof row.defaultWorkspace !== "string" || !row.defaultWorkspace.trim() ||
          row.defaultWorkspace.length > 4_000 || hasControlCharacter(row.defaultWorkspace))) {
        throw new Error("Invalid registration default workspace");
      }
      result = { ...named, action: row.action, environment,
        ...(row.defaultWorkspace === undefined ? {} : { defaultWorkspace: row.defaultWorkspace }) };
    } else {
      fields.push("expectedVersion", "configuration");
      result = { ...named, action: row.action, expectedVersion: revision(row.expectedVersion),
        configuration: parseSpaceAgentConfiguration(row.configuration) };
      spaceConfigurationResources(result.configuration);
    }
  } else if (row.action === "space-state") {
    fields.push("state", "expectedRevision");
    if (row.state !== "enabled" && row.state !== "disabled") throw new Error("Invalid Space state");
    result = { ...common, action: row.action, state: row.state, expectedRevision: revision(row.expectedRevision) };
  } else if (row.action === "owner-grant") {
    fields.push("state", "expectedRevision", "limits");
    const access = { ...common, expectedRevision: revision(row.expectedRevision), limits: parseRegistrationResourceLimits(row.limits) };
    if (row.state === "active" || row.state === "revoked") {
      result = { ...access, action: row.action, state: row.state };
    } else throw new Error("Invalid registration access state");
  } else throw new Error("Invalid registration action");
  if (Object.keys(row).some(field => !fields.includes(field))) throw new Error("Unknown registration command field");
  return result;
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid registration revision");
  }
  return value;
}
