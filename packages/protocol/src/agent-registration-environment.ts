import { utf8ByteLength } from "./hex.js";
import { parseAgentRegistrationKey, type AgentRegistrationKey } from "./agent-registration.js";
import { parseAgentRoutingDeclaration, type AgentRoutingDeclaration } from "./agent-routing.js";
import { AGENT_PRESET_BACKENDS, type AgentPresetBackend } from "./agent-presets.js";
import { hasControlCharacter } from "./field-validation.js";

/** How the Hub starts this harness on this machine. The Hub maintains it; the
 * machine keeps no installation record and never overrides these values. */
export interface AgentRegistrationLaunch {
  /** Launcher command or absolute path, found on the machine at spawn time. */
  runtime: string;
  runtimeArgs: string[];
  backend?: AgentPresetBackend;
  acpArgs?: string[];
}

/** Physical declarations belong to the machine owner. Workspace choice and
 * private secret references remain Space-local and are not copied here. */
export type AgentRegistrationEnvironment = Omit<AgentRoutingDeclaration, "defaultWorkspace"> & {
  launch?: AgentRegistrationLaunch;
};

function launchText(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      utf8ByteLength(value) > max || hasControlCharacter(value)) {
    throw new Error(`Invalid registration launch ${field}`);
  }
  return value;
}

function launchArgs(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`Invalid registration launch ${field}`);
  return value.map(item => {
    if (typeof item !== "string" || utf8ByteLength(item) > 4_000 || item.includes("\0")) {
      throw new Error(`Invalid registration launch ${field}`);
    }
    return item;
  });
}

/** Launch fields of the retired local sandbox and host-command reviewer. Stored
 * declarations may still carry them; they are read as absent and never written. */
const RETIRED_LAUNCH_FIELDS = ["requestReviewer", "sandboxMode"];

export function parseAgentRegistrationLaunch(value: unknown): AgentRegistrationLaunch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid registration launch");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(field => !["runtime", "runtimeArgs", "backend", "acpArgs", ...RETIRED_LAUNCH_FIELDS].includes(field))) {
    throw new Error("Invalid registration launch fields");
  }
  const backend = row.backend === undefined ? undefined : launchText(row.backend, 40, "backend");
  if (backend !== undefined && !AGENT_PRESET_BACKENDS.has(backend as AgentPresetBackend)) {
    throw new Error("Invalid registration launch backend");
  }
  const acpArgs = row.acpArgs === undefined ? undefined : launchArgs(row.acpArgs, "acpArgs");
  if (acpArgs?.length && backend !== "acp") throw new Error("Registration launch ACP arguments require the ACP backend");
  return { runtime: launchText(row.runtime, 4_000, "runtime"),
    runtimeArgs: row.runtimeArgs === undefined ? [] : launchArgs(row.runtimeArgs, "runtimeArgs"),
    ...(backend ? { backend: backend as AgentPresetBackend } : {}),
    ...(acpArgs?.length ? { acpArgs } : {}) };
}

export interface AgentEnvironmentCommand {
  key: AgentRegistrationKey;
  commandId: string;
  expectedVersion: number;
  environment: AgentRegistrationEnvironment;
}

export function parseAgentRegistrationEnvironment(value: unknown): AgentRegistrationEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.hasOwn(value, "defaultWorkspace")) {
    throw new Error("Physical environment cannot contain a Space workspace");
  }
  const { launch, ...declaration } = value as Record<string, unknown>;
  return { ...parseAgentRoutingDeclaration(declaration),
    ...(launch === undefined ? {} : { launch: parseAgentRegistrationLaunch(launch) }) };
}

export function parseAgentEnvironmentCommand(value: unknown): AgentEnvironmentCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid environment command");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(field => !["key", "commandId", "expectedVersion", "expectedMachineVersion",
    "machineMaxConcurrent", "environment"].includes(field)) ||
      typeof row.commandId !== "string" || !row.commandId || row.commandId !== row.commandId.trim() ||
      utf8ByteLength(row.commandId) > 200 || hasControlCharacter(row.commandId)) {
    throw new Error("Invalid environment command fields");
  }
  for (const field of ["expectedVersion"]) {
    if (typeof row[field] !== "number" || !Number.isSafeInteger(row[field]) || row[field] < 0 || row[field] >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Invalid environment revision");
    }
  }
  const environment = parseAgentRegistrationEnvironment(row.environment);
  return { key: parseAgentRegistrationKey(row.key), commandId: row.commandId,
    expectedVersion: Number(row.expectedVersion),
    environment };
}
