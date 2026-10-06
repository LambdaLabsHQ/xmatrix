import type {
  SerializedSpace,
  SpaceMemberCreationPolicy,
  SpaceMemberPermissions,
} from "@xmatrix/protocol";

export type SpaceMemberCreationCapability = keyof SpaceMemberPermissions;

export function effectiveSpaceMemberPermissions(
  space: SerializedSpace | null | undefined,
): SpaceMemberPermissions {
  return {
    agentCreation: space?.memberPermissions?.agentCreation ?? "members",
    automationCreation: space?.memberPermissions?.automationCreation ?? "members",
  };
}

export function spaceMemberCanCreate(
  space: SerializedSpace | null | undefined,
  userId: string,
  capability: SpaceMemberCreationCapability,
): boolean {
  return spacePrincipalCanCreate(space, { kind: "human", userId }, capability);
}

export function spacePrincipalCanCreate(
  space: SerializedSpace | null | undefined,
  principal: { kind: "human"; userId: string } | { kind: "agent" },
  capability: SpaceMemberCreationCapability,
): boolean {
  if (!space) return false;
  if (effectiveSpaceMemberPermissions(space)[capability] === "members") return true;
  if (principal.kind === "agent") return false;
  const role = space.members.find((member) => member.userId === principal.userId)?.role;
  return role === "owner" || role === "admin";
}

export function creationPolicyFromSwitch(allowMembers: boolean): SpaceMemberCreationPolicy {
  return allowMembers ? "members" : "admins";
}
