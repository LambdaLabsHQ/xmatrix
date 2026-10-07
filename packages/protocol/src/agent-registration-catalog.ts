import type { MachineResourceObservation, RoutingModelOption } from "./agent-routing.js";
import type { RoutingQuotaWindow } from "./agent-routing-quota-probe.js";
import type { LlmQuotaAccount } from "./authority-runtime.js";
import { parseSpaceAgentRegistrationKey, type SpaceAgentRegistrationKey } from "./agent-registration.js";
import type { SpaceAgentConfiguration } from "./agent-registration-configuration.js";
import type { RegistrationOwnerGrant, RegistrationSpacePolicy } from "./agent-registration-access.js";

export interface AgentRegistrationDetails {
  key: SpaceAgentRegistrationKey;
  displayName: string;
  version: number;
  /** Only the owner grants its registration to the Space (add back). */
  canManageOwnerGrant: boolean;
  canConfigureSpace: boolean;
  /** The owner or a Space owner/admin may remove it from the Space. */
  canRemoveFromSpace: boolean;
  configuration?: SpaceAgentConfiguration;
  access?: { grant: RegistrationOwnerGrant; policy: RegistrationSpacePolicy } | null;
}

export interface AgentRegistrationSummary {
  parameters?: import("./harness-parameters.js").HarnessParameter[];
  parameterModel?: string;
  key: SpaceAgentRegistrationKey;
  displayName: string;
  ownerName: string;
  machineName: string;
  version: number;
  /** `disabled`: a Space owner/admin disabled it in this Space. */
  state: "unshared" | "revoked" | "disabled" | "enabled";
  models: string[];
  /** Recent provider options, restricted to models authorized for this registration. */
  modelCatalog?: RoutingModelOption[];
  routingReady: boolean;
  routingBlocker?: "owner_environment_missing" | "owner_environment_disabled" | "model_unavailable" | "space_setup";
  canManageOwnerGrant: boolean;
  canConfigureSpace: boolean;
  canRemoveFromSpace: boolean;
  /** Where it stands right now. Absent from a Hub that does not report it. */
  live?: AgentRegistrationLiveState;
}

/**
 * What the registration is doing now, read with the catalog for display only.
 * Routing and access never read it back: the daemon connection, the Run and
 * the quota observation each remain the authority for their own fact.
 */
export interface AgentRegistrationLiveState {
  /** Whether the owner's daemon on this machine is connected; `lastSeenAt` is when that last changed.
   * `resources` is the connected daemon's current load sample, absent when it has none.
   * `platform` is the OS its daemon last reported, absent when none did. */
  machine: { online: boolean; lastSeenAt?: string; resources?: MachineResourceObservation;
    platform?: AgentRegistrationMachinePlatform };
  /** Its Instances with a running process in this Space, in Channels the reader may read. */
  running: AgentRegistrationRunningInstance[];
  /** The provider quota the router reads for it, while that reading is current.
   * Only its owner and the Space's owners and admins receive it. `windows`
   * are the provider's windows behind `remainingPercent` (the tightest one),
   * absent when the reading predates them. `account` is the provider's
   * verdict on the account from the same read. */
  quota?: { remainingPercent: number; observedAt: string; expiresAt: string; windows?: RoutingQuotaWindow[];
    account?: LlmQuotaAccount };
}

export type AgentRegistrationMachinePlatform = "windows" | "macos" | "linux";

export interface AgentRegistrationRunningInstance {
  instanceId: string;
  channelId: string;
  /** The Instance's ordinal in its Channel, as in `@codex:2`. */
  channelInstanceId: string;
  /** When its current Run started. */
  since: string;
  /** Whether it is in a turn now (Instance status `busy`). A live process
   * waiting for its next message is running but not working. Absent from a
   * Hub that does not report it. */
  working?: boolean;
}

export interface AgentCapabilitySummary {
  harness: string;
  models: string[];
  locations: AgentRegistrationSummary[];
}

/** One normal entry per harness. Concrete locations stay separate structured
 * choices; grouping never selects a machine, merges grants or grants access. */
export function groupAgentRegistrationCatalog(spaceId: string, registrations: readonly AgentRegistrationSummary[]): AgentCapabilitySummary[] {
  if (registrations.length > 10_000) throw new Error("Registration catalog exceeds its bound");
  const groups = new Map<string, AgentRegistrationSummary[]>(), seen = new Set<string>();
  for (const registration of registrations) {
    const key = parseSpaceAgentRegistrationKey(registration.key);
    if (key.spaceId !== spaceId) throw new Error("Registration catalog crosses its Space");
    const tuple = JSON.stringify([key.spaceId, key.ownerUserId, key.machineId, key.harness]);
    if (seen.has(tuple)) throw new Error("Duplicate registration in catalog");
    seen.add(tuple);
    const group = groups.get(key.harness) ?? [];
    group.push({ ...registration, key });
    groups.set(key.harness, group);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([harness, locations]) => ({
    harness, models: [...new Set(locations.filter(location => location.state === "enabled" && location.routingReady)
      .flatMap(location => location.models))].sort(),
    locations: locations.sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.machineName.localeCompare(b.machineName)
      || a.displayName.localeCompare(b.displayName) || a.key.ownerUserId.localeCompare(b.key.ownerUserId)
      || a.key.machineId.localeCompare(b.key.machineId)),
  }));
}
