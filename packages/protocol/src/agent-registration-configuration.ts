import { utf8ByteLength } from "./hex.js";
import { configurationFields } from "./configuration-fields.js";
import { parseAgentRoutingDeclaration, type AgentRoutingDeclaration } from "./agent-routing.js";
import { parseRegistrationResourceLimits, type RegistrationResourceLimits } from "./agent-registration-access.js";

/** Space admins may choose routing preferences, not declare another owner's
 * physical availability, browser/account capabilities or provider bindings. */
export type SpaceAgentRoutingSettings = Omit<AgentRoutingDeclaration,
  "availability" | "availableUntil" | "capabilities" | "modelAliases">;

/** Space settings deliberately exclude installation, executable, backend,
 * process environment, raw credentials and sandbox-authority fields. */
export interface SpaceAgentConfiguration {
  model?: string;
  reasoningEffort?: string;
  instructions?: string;
  workspaceReferences: string[];
  routing?: SpaceAgentRoutingSettings;
}

function routingSettings(value: unknown): SpaceAgentRoutingSettings {
  const row = configurationFields(value, ["schemaVersion", "enabled", "models", "description", "defaultWorkspace"], "Space routing settings");
  const { availability: _availability, capabilities: _capabilities, ...parsed } = parseAgentRoutingDeclaration({
    ...row, availability: "unknown", capabilities: [],
  });
  return parsed;
}

/** Retired fields: `role` with the Agent Role feature, `secretReferences`
 * when secrets moved to the Space. Configurations stored before, and older
 * clients, may still carry them; they are read as absent, without the
 * unknown-field diagnostic, and never written back. */
const RETIRED_CONFIGURATION_FIELDS = ["role", "secretReferences"] as const;

export function parseSpaceAgentConfiguration(value: unknown): SpaceAgentConfiguration {
  const row = configurationFields(value, ["model", "reasoningEffort", "instructions", "workspaceReferences",
    "routing", ...RETIRED_CONFIGURATION_FIELDS], "Space Agent configuration");
  const text = (field: string, max: number) => {
    const item = row[field];
    if (item === undefined) return {};
    if (typeof item !== "string" || !item.trim() || utf8ByteLength(item) > max ||
        item.includes("\u0000")) throw new Error(`Invalid Space Agent ${field}`);
    return { [field]: item };
  };
  const resources = parseRegistrationResourceLimits({ workspaces: row.workspaceReferences, models: [], capabilities: [] });
  return { ...text("model", 160), ...text("reasoningEffort", 80), ...text("instructions", 8_000),
    workspaceReferences: resources.workspaces,
    ...(row.routing === undefined ? {} : { routing: routingSettings(row.routing) }) };
}

/** Resource use still requires current admission. Saving a default never
 * grants a workspace, model or capability to a future Run. */
export function spaceConfigurationResources(configuration: SpaceAgentConfiguration): RegistrationResourceLimits {
  const value = parseSpaceAgentConfiguration(configuration);
  if (value.routing?.defaultWorkspace && !value.workspaceReferences.includes(value.routing.defaultWorkspace)) {
    throw new Error("Routing workspace must be an approved Space workspace reference");
  }
  return parseRegistrationResourceLimits({ workspaces: value.workspaceReferences,
    models: [...new Set([...(value.model ? [value.model] : []), ...(value.routing?.models ?? [])])],
    capabilities: [] });
}
