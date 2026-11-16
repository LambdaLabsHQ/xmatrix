import { utf8ByteLength } from "./hex.js";
import { parseAgentRegistrationKey, type AgentRegistrationKey } from "./agent-registration.js";
import { parseAgentRoutingDeclaration, type AgentRoutingDeclaration } from "./agent-routing.js";
import { AGENT_ACCESS_MODES, AGENT_PRESET_BACKENDS, agentAccessGrant, type AgentAccessGrant, type AgentAccessMode,
  type AgentPreset, type AgentPresetBackend } from "./agent-presets.js";
import { hasControlCharacter } from "./field-validation.js";

/** How the Hub starts this harness on this machine. The Hub maintains it; the
 * machine keeps no installation record and never overrides these values. */
export interface AgentRegistrationLaunch {
  /** Launcher command or absolute path, found on the machine at spawn time. */
  runtime: string;
  runtimeArgs: string[];
  backend?: AgentPresetBackend;
  acpArgs?: string[];
  /** The access mode the machine's owner confirmed when adding the Agent.
   * Absent on a registration added before the confirmation existed, which
   * launches as `full`: what every launch was until then. */
  access?: AgentAccessMode;
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
  if (Object.keys(row).some(field => !["runtime", "runtimeArgs", "backend", "acpArgs", "access", ...RETIRED_LAUNCH_FIELDS].includes(field))) {
    throw new Error("Invalid registration launch fields");
  }
  const backend = row.backend === undefined ? undefined : launchText(row.backend, 40, "backend");
  if (backend !== undefined && !AGENT_PRESET_BACKENDS.has(backend as AgentPresetBackend)) {
    throw new Error("Invalid registration launch backend");
  }
  const acpArgs = row.acpArgs === undefined ? undefined : launchArgs(row.acpArgs, "acpArgs");
  if (acpArgs?.length && backend !== "acp") throw new Error("Registration launch ACP arguments require the ACP backend");
  if (row.access !== undefined && !AGENT_ACCESS_MODES.includes(row.access as AgentAccessMode)) {
    throw new Error("Invalid registration launch access");
  }
  return { runtime: launchText(row.runtime, 4_000, "runtime"),
    runtimeArgs: row.runtimeArgs === undefined ? [] : launchArgs(row.runtimeArgs, "runtimeArgs"),
    ...(backend ? { backend: backend as AgentPresetBackend } : {}),
    ...(acpArgs?.length ? { acpArgs } : {}),
    ...(row.access === undefined ? {} : { access: row.access as AgentAccessMode }) };
}

/**
 * A registration launch as it starts: its access grant, and the argv that
 * carries the grant's args (the ACP argv for the generic ACP backend unless
 * the launch declares its own). The spawn and everything that shows a
 * registration's access read this one resolution.
 *
 * A daemon released before the grant reads access args only from the argv, so
 * they are joined there. That daemon adds Grok's flag itself; Grok's stay in
 * the grant alone.
 */
export function agentLaunchAccess(launch: AgentRegistrationLaunch | undefined, preset: AgentPreset | undefined):
  { access: AgentAccessGrant; confirmed: boolean; runtimeArgs: string[]; acpArgs: string[] } {
  const mode = launch?.access ?? "full", access = agentAccessGrant(preset, mode);
  const full = preset?.access?.full?.args ?? [], grok = preset?.backend === "grok-acp";
  const acp = (launch?.backend ?? preset?.backend) === "acp" && !launch?.runtimeArgs.length;
  const declared = (acp ? launch?.acpArgs : launch?.runtimeArgs) ?? [];
  // Before its owner was asked, a launch that declared its own arguments
  // started with exactly those: the grant reports the ones they carry and adds none.
  if (launch?.access === undefined && declared.length && !grok) access.args = access.args.filter(arg => declared.includes(arg));
  const base = declared.length ? declared : (acp ? preset?.acpArgs ?? ["acp"] : preset?.defaultArgs) ?? [];
  // `ask` drops a full-access arg saved with the launch before the modes existed.
  const kept = mode === "ask" ? base.filter(arg => !full.includes(arg)) : [...base];
  const argv = grok ? kept : [...kept, ...access.args.filter(arg => !kept.includes(arg))];
  return { access, confirmed: launch?.access !== undefined,
    runtimeArgs: acp ? [] : argv, acpArgs: acp ? argv : launch?.acpArgs ?? [] };
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
