import { AGENT_PRESETS, harnessVersionOutdated, parseHarnessInventory, type AgentRegistrationSummary, type SerializedMachineDaemon } from "@xmatrix/protocol";
import { harnessSpaceKey, harnessSpaceRegistration } from "./harness-space-switch";

/** Observed installed pairs, never registrations or authorization evidence.
 * Only the current owner's machines are offered for an owner switch. */
export function installedHarnessCandidates(spaceId: string, userId: string,
  daemons: readonly SerializedMachineDaemon[], registrations: readonly AgentRegistrationSummary[]) {
  const seen = new Set<string>();
  return daemons.flatMap((daemon) => {
    if (!daemon.machineId || daemon.userId !== userId) return [];
    const inventory = parseHarnessInventory(daemon.metadata.harnesses);
    return AGENT_PRESETS.flatMap((preset) => {
      const item = inventory?.items.find((entry) => entry.id === preset.id && entry.installed);
      if (preset.id === "custom" || !item) return [];
      const key = harnessSpaceKey(spaceId, userId, daemon.machineId!, preset.id);
      const id = JSON.stringify([key.spaceId, key.ownerUserId, key.machineId, key.harness]);
      if (seen.has(id)) return [];
      seen.add(id);
      return [{ id, key, preset, daemon, machineName: daemon.machineName ?? daemon.name, registration: harnessSpaceRegistration(registrations, key),
        version: item.version,
        // xMatrix routes nothing to it until it is updated (agent-registration-launch.ts).
        outdated: harnessVersionOutdated(preset.management, item.version) }];
    });
  }).sort((left, right) => left.preset.displayName.localeCompare(right.preset.displayName) ||
    left.machineName.localeCompare(right.machineName));
}
