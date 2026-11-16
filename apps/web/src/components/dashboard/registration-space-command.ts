import type {
  AgentRegistrationDetails, AgentRegistrationEnvironment, AgentWorkingMode, SpaceAgentRegistrationKey,
  AgentAccessMode,
} from "@xmatrix/protocol";
import { UserFacingProblem } from "../../lib/user-facing-error";

/** One user-facing change to a Space registration. `space-disable` and
 * `space-enable` are the Space's own state; `restore` is the owner's grant;
 * `configure` is the Space's configuration. An omitted display name keeps
 * the current one. */
export type RegistrationChange =
  | { kind: "configure"; model: string; displayName?: string; workingMode?: AgentWorkingMode; instructions?: string }
  | { kind: "space-disable" }
  | { kind: "space-enable" }
  | { kind: "restore" };

/** Read the current resource scope before editing one setting. Configuration
 * versions and access-policy revisions are independent concurrency domains. */
export function registrationSpaceCommand(key: SpaceAgentRegistrationKey, current: AgentRegistrationDetails,
  change: RegistrationChange): Record<string, unknown> {
  if (current.key.spaceId !== key.spaceId || current.key.ownerUserId !== key.ownerUserId ||
      current.key.machineId !== key.machineId || current.key.harness !== key.harness) {
    throw new UserFacingProblem("Registration settings could not be verified. Refresh and try again.");
  }
  if (change.kind === "restore") {
    if (!current.canManageOwnerGrant) throw new UserFacingProblem("Only the agent's owner can add it back to this Space.");
    const grant = current.access?.grant;
    if (!grant) throw new UserFacingProblem("Registration access grant is unavailable.");
    return { key, action: "owner-grant", state: "active", expectedRevision: grant.revision, limits: grant.limits };
  }
  if (change.kind === "space-disable" || change.kind === "space-enable") {
    if (!current.canConfigureSpace && !current.canManageOwnerGrant) {
      throw new UserFacingProblem("Only the agent's owner or a Space owner or admin can turn it on or off.");
    }
    const policy = current.access?.policy;
    if (!policy) throw new UserFacingProblem("Registration access is unavailable.");
    return { key, action: "space-state", state: change.kind === "space-disable" ? "disabled" : "enabled",
      expectedRevision: policy.revision };
  }
  if (!current.canConfigureSpace) throw new UserFacingProblem("Only a Space owner or admin can change this agent in the Space.");
  if (!current.configuration) throw new UserFacingProblem("Registration configuration is unavailable.");
  const { model: _previousModel, instructions: previousInstructions, ...configuration } = current.configuration;
  // An omitted `instructions` keeps the current text; an empty one clears it.
  const instructions = change.instructions === undefined ? previousInstructions : change.instructions.trim();
  return { key, action: "configure", displayName: change.displayName?.trim() || current.displayName,
    expectedVersion: current.version,
    configuration: { ...configuration, ...(change.model.trim() ? { model: change.model.trim() } : {}),
      ...(change.workingMode ? { workingMode: change.workingMode } : {}),
      ...(instructions ? { instructions } : {}) } };
}

/** A model the Space sets runs only where the owner's grant allows it. The
 * owner's grant command that adds `model`, or nothing when it already allows
 * it (or the change clears the model). */
export function registrationModelGrantCommand(key: SpaceAgentRegistrationKey, current: AgentRegistrationDetails,
  model: string): Record<string, unknown> | undefined {
  const wanted = model.trim();
  const grant = current.access?.grant;
  if (!wanted || grant?.limits.models.includes(wanted)) return undefined;
  if (!current.canManageOwnerGrant || !grant) {
    throw new UserFacingProblem(`Only the agent's owner can let it run ${wanted}.`);
  }
  return { key, action: "owner-grant", state: grant.state, expectedRevision: grant.revision,
    limits: { ...grant.limits, models: [...grant.limits.models, wanted] } };
}

/** The owner turns an agent off or on for its machine, in every Space, or
 * confirms what it may do there. */
export type EnvironmentChange = { kind: "disable" } | { kind: "enable" } | { kind: "access"; mode: AgentAccessMode };

export type EnvironmentState = { key: { ownerUserId: string; machineId: string; harness: string }; version: number;
  environment: AgentRegistrationEnvironment | null };

/** The environment command that changes only what was asked, against the version read. */
export function registrationEnvironmentCommand(current: EnvironmentState, change: EnvironmentChange): Record<string, unknown> {
  if (!current.environment) throw new UserFacingProblem("This agent is not set up on its machine.");
  const command = { key: current.key, commandId: `registration-ui:${crypto.randomUUID()}`, expectedVersion: current.version };
  if (change.kind !== "access") return { ...command, environment: { ...current.environment, enabled: change.kind === "enable" } };
  if (!current.environment.launch) throw new UserFacingProblem("This agent is not set up on its machine.");
  return { ...command, environment: { ...current.environment, launch: { ...current.environment.launch, access: change.mode } } };
}
