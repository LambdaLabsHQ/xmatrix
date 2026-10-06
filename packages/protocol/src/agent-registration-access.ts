import { utf8ByteLength } from "./hex.js";
import { hasControlCharacter } from "./field-validation.js";
import { configurationFields } from "./configuration-fields.js";
import { parseSpaceAgentRegistrationKey, type SpaceAgentRegistrationKey } from "./agent-registration.js";

/** Explicit resource references, never credential values or routing descriptions. */
export interface RegistrationResourceLimits {
  workspaces: string[];
  models: string[];
  capabilities: string[];
}

export interface RegistrationOwnerGrant {
  revision: number;
  executionRevision: number;
  state: "active" | "revoked";
  limits: RegistrationResourceLimits;
}

export interface RegistrationSpacePolicy {
  revision: number;
  /** Advances when the Space withdraws running work: on disabling. */
  executionRevision: number;
  /** A Space owner/admin disables an Agent in this Space: its running work
   * stops and it takes no new work here until they enable it. */
  state: "enabled" | "disabled";
  limits: RegistrationResourceLimits;
}

const dimensions = ["workspaces", "models", "capabilities"] as const;

/** Secrets belong to the Space and are read by a Run when it needs one, so a
 * registration no longer lists them. Limits stored before that may still carry
 * `secrets`; it is read as absent, without the unknown-field diagnostic. */
const RETIRED_DIMENSIONS = ["secrets"] as const;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid registration access fields");
  return value as Record<string, unknown>;
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid registration authorization revision");
  }
  return value;
}

function references(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== "string" ||
      item !== item.trim() || !item || utf8ByteLength(item) > 300 ||
      hasControlCharacter(item) || item.includes("*")) || new Set(value).size !== value.length) {
    throw new Error("Invalid registration resource references");
  }
  return [...value].sort();
}

export function parseRegistrationResourceLimits(value: unknown): RegistrationResourceLimits {
  const row = configurationFields(value, [...dimensions, ...RETIRED_DIMENSIONS], "registration resources");
  return { workspaces: references(row.workspaces), models: references(row.models),
    capabilities: references(row.capabilities) };
}

export function parseRegistrationOwnerGrant(value: unknown): RegistrationOwnerGrant {
  const row = record(value, ["revision", "executionRevision", "state", "limits"]);
  if (row.state !== "active" && row.state !== "revoked") throw new Error("Invalid owner grant state");
  const current = revision(row.revision), execution = revision(row.executionRevision);
  if (execution > current) throw new Error("Invalid owner execution revision");
  return { revision: current, executionRevision: execution, state: row.state, limits: parseRegistrationResourceLimits(row.limits) };
}

export function parseRegistrationSpacePolicy(value: unknown): RegistrationSpacePolicy {
  const row = record(value, ["revision", "executionRevision", "state", "limits"]);
  if (row.state !== "enabled" && row.state !== "disabled") throw new Error("Invalid Space state");
  const current = revision(row.revision), execution = revision(row.executionRevision);
  if (execution > current) throw new Error("Invalid Space execution revision");
  return { revision: current, executionRevision: execution, state: row.state, limits: parseRegistrationResourceLimits(row.limits) };
}

export function intersectRegistrationLimits(owner: RegistrationResourceLimits,
  space: RegistrationResourceLimits): RegistrationResourceLimits {
  const a = parseRegistrationResourceLimits(owner);
  const b = parseRegistrationResourceLimits(space);
  return Object.fromEntries(dimensions.map(key => [key, a[key].filter(ref => b[key].includes(ref))])) as unknown as RegistrationResourceLimits;
}

/** A Space policy cannot expand an owner's grant, even when edited by an admin. */
export function registrationLimitsWithin(candidate: RegistrationResourceLimits,
  ceiling: RegistrationResourceLimits): boolean {
  const a = parseRegistrationResourceLimits(candidate);
  const b = parseRegistrationResourceLimits(ceiling);
  return dimensions.every(key => a[key].every(ref => b[key].includes(ref)));
}

/** Resource removal revokes affected execution authority. */
export function registrationExecutionPermissionsPreserved(previous: RegistrationResourceLimits,
  next: RegistrationResourceLimits): boolean {
  const a = parseRegistrationResourceLimits(previous), b = parseRegistrationResourceLimits(next);
  return dimensions.every(key => a[key].every(ref => b[key].includes(ref)));
}

export interface RegistrationAdmissionFence {
  key: SpaceAgentRegistrationKey;
  grantRevision: number;
  grantExecutionRevision: number;
  policyRevision: number;
  policyExecutionRevision: number;
}

/** Inputs must be loaded by the owning server, not copied from a caller's metadata.
 * Execution allocation, Channel checks and startup-attempt fencing remain required. */
export function validateRegistrationAdmission(input: {
  key: SpaceAgentRegistrationKey;
  grant: RegistrationOwnerGrant;
  policy: RegistrationSpacePolicy;
  ownerIsMember: boolean;
  callerMayLaunch: boolean;
  requested: RegistrationResourceLimits;
  fence?: RegistrationAdmissionFence;
  /** Only the owning Run authority can choose continuation for an already
   * accepted execution. Queued dispatch and startup receipts use admission. */
  phase?: "admission" | "continuation";
}): { allowed: true; fence: RegistrationAdmissionFence; limits: RegistrationResourceLimits }
  | { allowed: false; reason: "membership" | "caller" | "revoked" | "disabled" | "stale_authorization" | "resources" } {
  const key = parseSpaceAgentRegistrationKey(input.key);
  const grant = parseRegistrationOwnerGrant(input.grant);
  const policy = parseRegistrationSpacePolicy(input.policy);
  if (input.ownerIsMember !== true) return { allowed: false, reason: "membership" };
  if (input.callerMayLaunch !== true) return { allowed: false, reason: "caller" };
  if (grant.state !== "active") return { allowed: false, reason: "revoked" };
  if (policy.state !== "enabled") return { allowed: false, reason: "disabled" };
  const continuation = input.phase === "continuation";
  if (continuation && !input.fence) return { allowed: false, reason: "stale_authorization" };
  if (input.fence) {
    const prior = parseSpaceAgentRegistrationKey(input.fence.key);
    if (prior.spaceId !== key.spaceId || prior.ownerUserId !== key.ownerUserId ||
        prior.machineId !== key.machineId || prior.harness !== key.harness ||
        input.fence.grantExecutionRevision !== grant.executionRevision || input.fence.policyExecutionRevision !== policy.executionRevision ||
        (!continuation && (input.fence.grantRevision !== grant.revision || input.fence.policyRevision !== policy.revision))) {
      return { allowed: false, reason: "stale_authorization" };
    }
  }
  const limits = intersectRegistrationLimits(grant.limits, policy.limits);
  if (!registrationLimitsWithin(input.requested, limits)) {
    return { allowed: false, reason: "resources" };
  }
  return { allowed: true, limits, fence: input.fence ?? { key, grantRevision: grant.revision,
    grantExecutionRevision: grant.executionRevision, policyRevision: policy.revision, policyExecutionRevision: policy.executionRevision } };
}
