import type {
  AgentRegistrationDetails, AgentRegistrationEnvironment, AgentWorkingMode, SpaceAgentRegistrationKey,
} from "@xmatrix/protocol";

/** One user-facing change to a Space registration. `space-disable` and
 * `space-enable` are the Space's own state; `restore` is the owner's grant;
 * `configure` is the Space's configuration. An omitted display name keeps
 * the current one. */
export type RegistrationChange =
  | { kind: "configure"; model: string; displayName?: string; workingMode?: AgentWorkingMode }
  | { kind: "space-disable" }
  | { kind: "space-enable" }
  | { kind: "restore" };

/** Read the current resource scope before editing one setting. Configuration
 * versions and access-policy revisions are independent concurrency domains. */
export function registrationSpaceCommand(key: SpaceAgentRegistrationKey, current: AgentRegistrationDetails,
  change: RegistrationChange): Record<string, unknown> {
  if (current.key.spaceId !== key.spaceId || current.key.ownerUserId !== key.ownerUserId ||
      current.key.machineId !== key.machineId || current.key.harness !== key.harness) {
    throw new Error("Registration settings could not be verified. Refresh and try again.");
  }
  if (change.kind === "restore") {
    if (!current.canManageOwnerGrant) throw new Error("Only the agent's owner can add it back to this Space.");
    const grant = current.access?.grant;
    if (!grant) throw new Error("Registration access grant is unavailable.");
    return { key, action: "owner-grant", state: "active", expectedRevision: grant.revision, limits: grant.limits };
  }
  if (change.kind === "space-disable" || change.kind === "space-enable") {
    if (!current.canConfigureSpace && !current.canManageOwnerGrant) {
      throw new Error("Only the agent's owner or a Space owner or admin can turn it on or off.");
    }
    const policy = current.access?.policy;
    if (!policy) throw new Error("Registration access is unavailable.");
    return { key, action: "space-state", state: change.kind === "space-disable" ? "disabled" : "enabled",
      expectedRevision: policy.revision };
  }
  if (!current.canConfigureSpace) throw new Error("Only a Space owner or admin can change this agent in the Space.");
  if (!current.configuration) throw new Error("Registration configuration is unavailable.");
  const { model: _previousModel, ...configuration } = current.configuration;
  return { key, action: "configure", displayName: change.displayName?.trim() || current.displayName,
    expectedVersion: current.version,
    configuration: { ...configuration, ...(change.model.trim() ? { model: change.model.trim() } : {}),
      ...(change.workingMode ? { workingMode: change.workingMode } : {}) } };
}

/** The owner turns an agent off or on for its machine, in every Space. */
export type EnvironmentChange = { kind: "disable" } | { kind: "enable" };

export type EnvironmentState = { key: { ownerUserId: string; machineId: string; harness: string }; version: number;
  environment: AgentRegistrationEnvironment | null };

/** The environment command that flips only `enabled`, against the version read. */
export function registrationEnvironmentCommand(current: EnvironmentState, change: EnvironmentChange): Record<string, unknown> {
  if (!current.environment) throw new Error("This agent is not set up on its machine.");
  return { key: current.key, commandId: `registration-ui:${crypto.randomUUID()}`, expectedVersion: current.version,
    environment: { ...current.environment, enabled: change.kind === "enable" } };
}
