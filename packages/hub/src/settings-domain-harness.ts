import {
  agentPresetById, agentPresetForLauncher, appViewAddress, harnessItemObservedAt, parseHarnessInventory,
  type SerializedMachineDaemon, type SettingDescriptor,
} from "@xmatrix/protocol";
import { MACHINE_ACTION_DELIVERY } from "./machine-action-routes";
import type { SettingDomainResolver, SettingsReader } from "./settings-registry";
import type { Env } from "./types";

/** The Machines the domain reads, replaceable in tests. */
export interface HarnessSettingsPort {
  daemons(env: Env, ownerUserId: string): Promise<SerializedMachineDaemon[]>;
}

/** The harness an address names, by id (`antigravity`) or launcher (`agy`); never `custom`. */
export function settingHarness(named: string) {
  const preset = agentPresetById(named.toLowerCase()) ?? agentPresetForLauncher(named);
  return preset && preset.id !== "custom" ? preset : undefined;
}

/**
 * `harness:<machine>/<harness>/sign-in`: a harness signed in on one of the
 * asking Run owner's Machines, as the Machine's daemon last observed it. Only
 * that owner signs in, on the Machine through its own harness actions, so
 * the domain writes nothing itself.
 */
export function harnessSettingsDomain(port: HarnessSettingsPort = MACHINE_ACTION_DELIVERY): SettingDomainResolver {
  return {
    async describe(reader: SettingsReader, addresses) {
      const owner = reader.asker?.userId ?? reader.userId;
      const daemons = await port.daemons(reader.env, owner);
      const described: SettingDescriptor[] = [];
      for (const address of addresses) {
        const [machine, named] = address.parts as [string, string];
        const preset = settingHarness(named);
        if (!preset) return `${named} is not a harness xMatrix knows`;
        const daemon = daemons.find((item) => item.machineId === machine) ??
          daemons.find((item) => (item.machineName ?? item.name ?? "").trim().toLowerCase() === machine.toLowerCase());
        if (!daemon) return `${machine} is not one of the asking Agent's owner's Machines`;
        const machineId = daemon.machineId ?? machine;
        const machineName = (daemon.machineName ?? daemon.name ?? "").trim() || machineId;
        const inventory = parseHarnessInventory(daemon.metadata?.harnesses);
        const item = inventory?.items.find((entry) => entry.id === preset.id);
        if (item && !item.installed) return `${preset.displayName} is not installed on ${machineName}; install it there first: xmatrix harness install ${preset.id}`;
        const signedIn = item?.login === "signed_in";
        const observed = inventory && item ? harnessItemObservedAt(inventory, item) : Number.NaN;
        described.push({ address: `harness:${machineId}/${preset.id}/sign-in`, domain: "harness",
          scope: `${preset.displayName} on ${machineName}`, label: `Sign in to ${preset.displayName}`,
          control: "harness-sign-in", sensitivity: "secret", writer: "machine-owner",
          state: signedIn ? "verified" : "missing",
          satisfied: signedIn && (!reader.since || observed > Date.parse(reader.since)),
          canWrite: reader.userId === owner, href: appViewAddress(reader.spaceId, "machines", machineId),
          ...(item?.login === "signed_out" && item.loginDetail ? { problem: item.loginDetail } : {}) });
      }
      return described;
    },
  };
}
