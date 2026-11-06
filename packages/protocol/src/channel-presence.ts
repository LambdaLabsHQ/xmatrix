import { mergeAgentInstancePresence } from "./instance-presence-merge.js";
import { sameValue } from "./same-value.js";
import type { SerializedAgentInstance } from "./authority-foundation.js";
import { parseAgentRegistrationKey, sameAgentRegistration, type AgentRegistrationKey } from "./agent-registration.js";
import type { ChannelHumanMemberPresence, LlmUsage, SerializedChannel } from "./authority-runtime.js";

declare const instanceIdentity: unique symbol;
export type PresenceInstanceId = string & { readonly [instanceIdentity]: true };

export type HumanDevicePresence = Readonly<Pick<SerializedAgentInstance,
  "id" | "label" | "status" | "hostName" | "connectedAt" | "lastSeenAt"> & { platform?: string }>;
export type HumanPresence = Readonly<Omit<ChannelHumanMemberPresence,
  "kind" | "instances" | "activity" | "files" | "intent" | "runtimeState" | "goal" | "usage"> & {
  devices: readonly HumanDevicePresence[];
}>;
export type AgentInstancePresence = Readonly<Omit<SerializedAgentInstance, "id" | "channelId"> & {
  id: PresenceInstanceId;
  channelId: string;
  agentName: string;
  registration: Readonly<AgentRegistrationKey>;
  email?: string;
}>;

/** Runtime presentation only. Membership and execution admission stay server-owned. */
export interface ChannelPresence {
  readonly channelId: string;
  readonly humans: ReadonlyMap<string, HumanPresence>;
  readonly instances: ReadonlyMap<PresenceInstanceId, AgentInstancePresence>;
  /**
   * `false`: this presence speaks only for Agents (`presenceCoverage: "agents"`
   * on the wire), so `humans` says nothing about the Channel's people.
   */
  readonly humansCovered?: false;
}

/** Internal model. The legacy member-to-array wire shape never enters a store. */
export type ChannelSnapshot = Omit<SerializedChannel, "memberPresence"> & {
  readonly presence: ChannelPresence | undefined;
};

export class ChannelPresenceConflict extends Error {
  constructor(readonly channelId: string, readonly instanceId?: string) {
    super("Conflicting Channel Instance identity; refresh the Channel snapshot");
    this.name = "ChannelPresenceConflict";
  }
}

/** Only boundary codecs turn an opaque Instance identity into a model key. */
export function presenceInstanceId(value: string): PresenceInstanceId {
  if (typeof value !== "string" || !value || value.length > 300) throw new TypeError("Invalid Instance identity");
  return value as PresenceInstanceId;
}

type InstancePatch = Partial<Omit<AgentInstancePresence, "id" | "channelId" | "channelInstanceId" | "registration">>;
export type ChannelPresenceChange =
  | { type: "snapshot"; snapshot: ChannelPresence }
  | { type: "upsert"; source: "snapshot" | "live"; authoritative?: boolean; instance: AgentInstancePresence }
  | { type: "patch_known"; source?: "message"; instanceId: PresenceInstanceId; patch: InstancePatch }
  | { type: "quota"; instanceId: PresenceInstanceId; usage: LlmUsage }
  | { type: "remove"; instanceId: PresenceInstanceId }
  | { type: "humans"; humans: ReadonlyMap<string, HumanPresence> };

export function emptyChannelPresence(channelId: string): ChannelPresence {
  return { channelId, humans: new Map(), instances: new Map() };
}

/** The only writer of the internal maps. Full snapshots are decoded independently. */
export function reduceChannelPresence(state: ChannelPresence, change: ChannelPresenceChange): ChannelPresence {
  if (change.type === "snapshot") {
    const { snapshot } = change;
    if (snapshot.channelId !== state.channelId) throw new ChannelPresenceConflict(state.channelId);
    const instances = new Map<PresenceInstanceId, AgentInstancePresence>();
    for (const incoming of snapshot.instances.values()) {
      const current = state.instances.get(incoming.id);
      const value = current && sameAgentRegistration(current.registration, incoming.registration)
        ? mergeAgentInstancePresence(current, incoming) : incoming;
      instances.set(incoming.id, sameValue(current, value) ? current! : value);
    }
    // A snapshot that speaks only for Agents leaves the people as they were.
    const { humansCovered, ...covered } = snapshot;
    const next: ChannelPresence = humansCovered === false
      ? { ...covered, humans: state.humans, ...(state.humansCovered === false ? { humansCovered } : {}), instances }
      : { ...covered, instances };
    return sameValue(state, next) ? state : next;
  }
  if (change.type === "humans") {
    if (change.humans === state.humans && state.humansCovered !== false) return state;
    const { humansCovered: _uncovered, ...rest } = state;
    return { ...rest, humans: new Map(change.humans) };
  }
  const id = change.type === "upsert" ? change.instance.id : change.instanceId;
  if (typeof id !== "string" || !id) throw new TypeError("An exact Instance identity is required");
  const current = state.instances.get(id);
  if (change.type === "remove") {
    if (!current) return state;
    const instances = new Map(state.instances);
    instances.delete(id);
    return { ...state, instances };
  }
  if ((change.type === "patch_known" || change.type === "quota") && !current) return state;
  let next = change.type === "upsert" ? change.instance : change.type === "quota"
    ? { ...current!, usage: change.usage } : { ...current!, ...change.patch };
  parseAgentRegistrationKey(next.registration);
  if (current && !sameAgentRegistration(current.registration, next.registration)) throw new ChannelPresenceConflict(state.channelId, id);
  if ((current?.channelInstanceId && next.channelInstanceId !== current.channelInstanceId) ||
      next.channelId !== state.channelId || next.id !== id) throw new ChannelPresenceConflict(state.channelId, id);
  for (const other of state.instances.values()) {
    if (other.id !== id && next.channelInstanceId && other.channelInstanceId === next.channelInstanceId) {
      throw new ChannelPresenceConflict(state.channelId, id);
    }
  }
  if (!current && change.type === "upsert" && change.source !== "snapshot") throw new ChannelPresenceConflict(state.channelId, id);
  if (current) {
    if (change.type === "patch_known" && change.source === "message" && current.status === "offline" && !current.rest) {
      next = { ...next, status: current.status, rest: current.rest, offlineReason: current.offlineReason };
    }
    if (change.type !== "quota" && (change.type !== "upsert" || !change.authoritative)) {
      next = mergeAgentInstancePresence(current, next);
    }
  }
  if (sameValue(next, current)) return state;
  const instances = new Map(state.instances);
  instances.set(id, next);
  return { ...state, instances };
}

/** Display order and daemon exclusion are shared by every Instance selector. */
export function channelPresenceInstances(presence: ChannelPresence | undefined): readonly AgentInstancePresence[] {
  return [...(presence?.instances.values() ?? [])].filter(instance => {
    const name = instance.agentName.trim().toLowerCase();
    return name !== "xmatrix-daemon" && !name.startsWith("xmatrix-daemon-");
  }).sort((left, right) => {
    const birth = Date.parse(left.connectedAt) - Date.parse(right.connectedAt);
    if (Number.isFinite(birth) && birth) return birth;
    const slot = Number(left.channelInstanceId || 0) - Number(right.channelInstanceId || 0);
    return slot || left.id.localeCompare(right.id);
  });
}

export type ChannelSnapshotCatalogPageRow = Omit<import("./authority-runtime.js").ChannelCatalogPageRow, "channel"> & { channel: ChannelSnapshot };
export type ChannelSnapshotCatalogPage = Omit<import("./authority-runtime.js").ChannelCatalogPage, "rows"> & { rows: ChannelSnapshotCatalogPageRow[] };
export type ChannelSnapshotCatalogResolveResult = Omit<import("./authority-runtime.js").ChannelCatalogResolveResult, "channels"> & { channels: ChannelSnapshot[] };
