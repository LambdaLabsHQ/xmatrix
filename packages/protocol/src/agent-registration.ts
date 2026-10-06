import { utf8ByteLength } from "./hex.js";
import { agentPresetForLauncher } from "./agent-presets.js";
import { hasControlCharacter } from "./field-validation.js";

/** Registration identity is a tuple, never a display name or generated UUID.
 * Configuration, Space grants and execution identities are separate facts. */
export interface AgentRegistrationKey {
  ownerUserId: string;
  machineId: string;
  harness: string;
}

/** Configurations and grants always include the owning Space. */
export interface SpaceAgentRegistrationKey extends AgentRegistrationKey {
  spaceId: string;
}

function identityPart(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() ||
      utf8ByteLength(value) > 300 || hasControlCharacter(value)) {
    throw new Error(`Invalid Agent registration ${field}`);
  }
  return value;
}

/** Normalize legacy runtime aliases without making configuration part of identity. */
export function canonicalRegistrationHarness(value: unknown): string {
  const runtime = identityPart(value, "harness");
  const known = agentPresetForLauncher(runtime);
  if (known) return known.id;
  if (!/^[a-z][a-z0-9-]{0,79}$/u.test(runtime) || runtime === "custom") {
    throw new Error("Agent registration requires a concrete harness");
  }
  return runtime;
}

export function parseAgentRegistrationKey(value: unknown): AgentRegistrationKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Agent registration key");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(field => !["ownerUserId", "machineId", "harness"].includes(field))) {
    throw new Error("Agent registration key contains an extra identity dimension");
  }
  return {
    ownerUserId: identityPart(row.ownerUserId, "ownerUserId"),
    machineId: identityPart(row.machineId, "machineId"),
    harness: canonicalRegistrationHarness(row.harness),
  };
}

export function sameAgentRegistration(left: AgentRegistrationKey, right: AgentRegistrationKey): boolean {
  return left.ownerUserId === right.ownerUserId && left.machineId === right.machineId &&
    left.harness === right.harness;
}

export function parseSpaceAgentRegistrationKey(value: unknown): SpaceAgentRegistrationKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Space Agent registration key");
  }
  const { spaceId, ...registration } = value as Record<string, unknown>;
  return { spaceId: identityPart(spaceId, "spaceId"), ...parseAgentRegistrationKey(registration) };
}
