import { utf8ByteLength } from "./hex.js";
import { parseSpaceAgentRegistrationKey, type SpaceAgentRegistrationKey } from "./agent-registration.js";
import { parseRegistrationResourceLimits, type RegistrationResourceLimits } from "./agent-registration-access.js";
import { hasControlCharacter } from "./field-validation.js";

/** A versioned, Run-scoped launch grant. It names an installation and admitted
 * resources, never an executable, environment values or a replacement Agent ID. */
export interface RegistrationLaunchBinding {
  schemaVersion: 1;
  key: SpaceAgentRegistrationKey;
  runId: string;
  instanceId: string;
  allocationId: string;
  authorizationDigest: string;
  environmentVersion: number;
  runtimeModel?: string;
  resources: RegistrationResourceLimits;
}

export function parseRegistrationLaunchBinding(value: unknown): RegistrationLaunchBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid registration launch binding");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(field => !["schemaVersion", "key", "runId", "instanceId", "allocationId",
    "authorizationDigest", "environmentVersion", "runtimeModel", "resources"].includes(field)) || row.schemaVersion !== 1 ||
    typeof row.authorizationDigest !== "string" || !/^[a-f0-9]{64}$/u.test(row.authorizationDigest) ||
    typeof row.environmentVersion !== "number" || !Number.isSafeInteger(row.environmentVersion) || row.environmentVersion < 1) {
    throw new Error("Invalid registration launch authority");
  }
  const identity = (field: string) => {
    const value = row[field];
    if (typeof value !== "string" || !value || value !== value.trim() || utf8ByteLength(value) > 300 ||
      hasControlCharacter(value)) throw new Error("Invalid registration execution identity");
    return value;
  };
  const resources = parseRegistrationResourceLimits(row.resources);
  // No workspace reference is a private managed directory.
  if (resources.models.length > 1 || resources.workspaces.length > 1 ||
      (resources.models.length === 0) !== (row.runtimeModel === undefined)) {
    throw new Error("A registration launch must select one model and at most one workspace");
  }
  return { schemaVersion: 1, key: parseSpaceAgentRegistrationKey(row.key), runId: identity("runId"),
    instanceId: identity("instanceId"), allocationId: identity("allocationId"), authorizationDigest: row.authorizationDigest,
    environmentVersion: row.environmentVersion, ...(row.runtimeModel === undefined ? {} : { runtimeModel: identity("runtimeModel") }), resources };
}

/** The binding as a daemon receives it. Daemons released before secrets moved
 * to the Space require `resources.secrets`; a registration lists none now, so
 * it is always empty. Drop this once those daemons can no longer launch. */
export function registrationLaunchBindingForDaemon(binding: RegistrationLaunchBinding) {
  return { ...binding, resources: { ...binding.resources, secrets: [] as string[] } };
}
