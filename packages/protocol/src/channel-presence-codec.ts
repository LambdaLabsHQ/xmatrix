import { parseAgentRegistrationKey } from "./agent-registration.js";
import { agentInstanceMemberPresence } from "./channel-presence-selectors.js";
import type { SerializedAgentInstance } from "./authority-foundation.js";
import { withRegistrationQuota, type ChannelMemberPresence, type SerializedChannel } from "./authority-runtime.js";
import { emptyChannelPresence, presenceInstanceId, reduceChannelPresence,
  type AgentInstancePresence, type ChannelPresence, type ChannelSnapshot, type HumanPresence } from "./channel-presence.js";

/** Legacy wire compatibility ends here. Never infer Instance identity from a member key. */
export function decodeChannelSnapshot(channel: SerializedChannel | ChannelSnapshot): ChannelSnapshot {
  try {
    return decodePresence(channel);
  } catch {
    // A broken authoritative row cannot poison a directory page or trigger
    // another read of the same broken snapshot. Preserve metadata and prior
    // presentation (undefined is not an authoritative empty snapshot).
    console.error("[presence] invalid_authoritative_snapshot", channel.id);
    const { memberPresence: _members, ...metadata } = channel as SerializedChannel;
    return { ...metadata, presence: undefined };
  }
}

function decodePresence(channel: SerializedChannel | ChannelSnapshot): ChannelSnapshot {
  if ("presence" in channel && !Object.prototype.hasOwnProperty.call(channel, "memberPresence")) {
    if (channel.presence && (!(channel.presence.instances instanceof Map) || !(channel.presence.humans instanceof Map))) {
      throw new TypeError("Invalid internal Channel presence model");
    }
    return channel as ChannelSnapshot;
  }
  const { memberPresence, presenceCoverage, ...metadata } = channel as SerializedChannel;
  if (memberPresence === undefined) return { ...metadata, presence: undefined };
  // Speaking only for Agents, the snapshot carries no people to read.
  const agentsOnly = presenceCoverage === "agents";
  let presence = emptyChannelPresence(channel.id);
  const humans = new Map<string, HumanPresence>();
  const entries = Object.entries(memberPresence);
  // A catalog member wins over an older prefixed alias of that exact Instance.
  const canonical = ([key, value]: [string, ChannelMemberPresence]) =>
    value.kind === "agent" && value.instances?.some(instance => instance.id === key) ? 1 : 0;
  entries.sort((left, right) => canonical(right) - canonical(left));
  let aliases = 0;
  let invalidHumans = 0;
  for (const [member, value] of entries) {
    if (value.kind === "user") {
      if (agentsOnly) continue;
      if (!member.startsWith("user:")) { invalidHumans++; continue; }
      const { instances: devices = [], kind: _kind, activity: _activity, files: _files, intent: _intent,
        runtimeState: _runtimeState, goal: _goal, usage: _usage, ...human } = value;
      humans.set(member, { ...human, devices: devices.map(device => ({ id: device.id,
        label: device.label, status: device.status, hostName: device.hostName, platform: (device as SerializedAgentInstance & { platform?: string }).platform,
        connectedAt: device.connectedAt, lastSeenAt: device.lastSeenAt })) });
      continue;
    }
    if (!Array.isArray(value.instances ?? [])) throw new TypeError("Invalid Channel Instance collection");
    for (const instance of value.instances ?? []) {
      const id = presenceInstanceId(instance.id);
      if (presence.instances.has(id)) { aliases++; continue; }
      // Aggregate Run activity, intent, files and clocks never fan out to siblings.
      const usage = value.usage?.quotaSource === "provider_api" || value.usage?.quotaState
        ? withRegistrationQuota(instance.usage, value.usage) : instance.usage;
      const entry: AgentInstancePresence = { ...instance, id, channelId: channel.id,
        agentName: value.label || instance.label || "Agent", registration: parseAgentRegistrationKey(value.registration),
        email: value.email, ...(usage ? { usage } : {}) };
      presence = reduceChannelPresence(presence, { type: "upsert", source: "snapshot", instance: entry });
    }
  }
  if (aliases || invalidHumans) console.warn("[presence] legacy_wire_aliases", channel.id, { aliases, invalidHumans });
  if (agentsOnly) return { ...metadata, presence: { ...presence, humansCovered: false } };
  presence = reduceChannelPresence(presence, { type: "humans", humans });
  return { ...metadata, presence };
}

/** Encode only at an external boundary: one legacy member for each Instance. */
export function encodeChannelSnapshot(channel: ChannelSnapshot): SerializedChannel {
  const { presence, ...metadata } = channel;
  if (presence === undefined) return metadata;
  return {
    ...metadata,
    memberPresence: encodeChannelPresence(presence),
    ...(presence.humansCovered === false ? { presenceCoverage: "agents" as const } : {}),
  };
}

export function encodeChannelPresence(presence: ChannelPresence): Record<string, ChannelMemberPresence> {
  const members: Record<string, ChannelMemberPresence> = {};
  for (const [id, human] of presence.humansCovered === false ? [] : presence.humans) {
    const { devices, ...value } = human;
    members[id] = { ...value, kind: "user", instances: devices.map(device => ({ ...device })) };
  }
  for (const instance of presence.instances.values()) {
    members[instance.id] = agentInstanceMemberPresence(instance);
  }
  return members;
}

export function decodeChannelCatalogPage(page: import("./authority-runtime.js").ChannelCatalogPage): import("./channel-presence.js").ChannelSnapshotCatalogPage {
  return { ...page, rows: page.rows.map(row => ({ ...row, channel: decodeChannelSnapshot(row.channel) })) };
}
export function decodeChannelCatalogResolve(result: import("./authority-runtime.js").ChannelCatalogResolveResult): import("./channel-presence.js").ChannelSnapshotCatalogResolveResult {
  return { ...result, channels: result.channels.map(decodeChannelSnapshot) };
}
