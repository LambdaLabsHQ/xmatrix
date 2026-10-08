import type { AgentPreset, AgentRegistrationSummary, SpaceAgentRegistrationKey } from "@xmatrix/protocol";
import { registrationSwitch, type RegistrationSwitch } from "./my-agents-registrations";

/**
 * Whether a harness installed on a machine can be summoned in a Space. Nothing
 * is added to the Space: the machine and harness are already known from the
 * machine's inventory, and this switch is the only thing chosen. The first
 * time it is turned on, the registration that stores it is written (`create`,
 * which also adds back one its owner removed); after that, it flips the same
 * states the Agents page does.
 */
export interface HarnessSpaceSwitch {
  on: boolean;
  /** Write the registration before anything else. */
  create: boolean;
  changes: RegistrationSwitch["changes"];
}

export function harnessSpaceKey(spaceId: string, ownerUserId: string, machineId: string,
  presetId: string): SpaceAgentRegistrationKey {
  return { spaceId, ownerUserId, machineId, harness: presetId };
}

export function harnessSpaceRegistration(registrations: readonly AgentRegistrationSummary[] | undefined,
  key: SpaceAgentRegistrationKey): AgentRegistrationSummary | undefined {
  return registrations?.find((registration) => registration.key.spaceId === key.spaceId &&
    registration.key.ownerUserId === key.ownerUserId && registration.key.machineId === key.machineId &&
    registration.key.harness === key.harness);
}

/** The machine's owner holds this switch. A registration the Space offered
 * but its owner never granted has no switch here: answering that offer is
 * not the same as turning it on. */
export function harnessSpaceSwitch(registration: AgentRegistrationSummary | undefined): HarnessSpaceSwitch | null {
  if (!registration || registration.state === "revoked") return { on: false, create: true, changes: [] };
  if (registration.state === "unshared") return null;
  const toggle = registrationSwitch(registration);
  return toggle && { on: toggle.on, create: false, changes: toggle.changes };
}

/** The command that writes the registration from the preset's own launch,
 * as `xmatrix agent add` does. It is named after the harness. */
export function harnessSpaceCreateCommand(key: SpaceAgentRegistrationKey, preset: AgentPreset): Record<string, unknown> {
  return {
    action: "create",
    commandId: `registration-create:${crypto.randomUUID()}`,
    key,
    displayName: preset.id,
    environment: {
      schemaVersion: 1, enabled: true, models: [], description: "", availability: "unknown", capabilities: [],
      launch: { runtime: preset.runtime, runtimeArgs: preset.defaultArgs, ...(preset.backend ? { backend: preset.backend } : {}) },
    },
  };
}

/** A harness installed through xMatrix is turned on in the Space it was
 * installed from, once: only when the install succeeded and the Space has
 * never had it. One already on the machine, or one turned off before, keeps
 * its switch as it is. */
export function harnessTurnsOnAfterInstall(registration: AgentRegistrationSummary | undefined,
  outcome: { action: string; status?: string; installed?: boolean }): boolean {
  return outcome.action === "install" && outcome.status === "succeeded" && outcome.installed === true && !registration;
}
