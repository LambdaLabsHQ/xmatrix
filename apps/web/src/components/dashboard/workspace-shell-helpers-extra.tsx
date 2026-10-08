"use client";

import type {
  WorkspaceSearchResult,
} from "./workspace-shell-search-model";

import { formatRelativeAge, formatZonedDateTime } from "./time-display";

import {
  channelMatchesSearch,
  channelReadCountsStorageKey,
  normalizeChannelSearchText,
  searchResultRank,
} from "./workspace-shell-search-model";

export type { ChannelTreeNode, WorkspaceSearchResult } from "./workspace-shell-search-model";
export {
  channelMatchesSearch,
  channelReadCountsStorageKey,
  normalizeChannelSearchText,
  searchResultRank,
} from "./workspace-shell-search-model";

import {
  CHANNEL_HISTORY_CACHE_MAX_AGE_MS,
  CHANNEL_HISTORY_CACHE_MAX_CHANNELS,
  CHANNEL_HISTORY_CACHE_MAX_MESSAGES,
  CHANNEL_MENTION_CLEARED_STORAGE_PREFIX,
  WORKING_SPACE_KV_KEY,
  WORKING_SPACE_STORAGE_PREFIX,
} from "./workspace-shell-constants";

import { metadataString } from "./workspace-shell-formatters";

export { channelAttachmentKindForMimeType } from "./workspace-shell-formatters";

import {
  isLiveMachineDaemon,
  machineIdentityKeys,
  normalizedMachineKeys,
  preferredMachineDaemon,
} from "./machine-daemon-presence";

export {
  daemonPresenceLabel,
  isLiveMachineDaemon,
  machineIdentityKeys,
  preferredMachineDaemon,
} from "./machine-daemon-presence";

import {
  ChannelHistoryCacheEntry,
  LocalManagedAgent,
  MachineSummary,
} from "./workspace-shell-helpers";

// Pure helpers inlined here to avoid helpers-extra ↔ recovered import cycles.
// Canonical exports for the rest of the shell remain in workspace-shell-recovered.

function shortId(id: string): string {
  return id.slice(0, 8);
}

/* An evidence line quoted into a channel or a ticket loses its surroundings,
   so it carries its zone. */
function formatDateTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) return "Unavailable";
  return formatZonedDateTime(value, undefined, undefined, { month: "short" });
}

function relativeTime(value: string): string {
  return formatRelativeAge(value) ?? value;
}

function eventMetadataString(
  event: { metadata?: Record<string, unknown> | null },
  key: string,
): string {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function eventLabel(event: {
  type: string;
  metadata?: Record<string, unknown> | null;
}): string {
  if (event.type === "channel_mention") {
    return event.metadata?.reason === "reply" ? "replied to you" : "mentioned you";
  }
  if (event.type === "channel_attention_updated") {
    return "mentioned you";
  }
  return event.type.replace(/_/g, " ");
}

import { registrationTupleId } from "./use-registration-command";

import {
  Building,
  Bot,
  FileText,
  Hash,
  HardDrive,
  MessageSquare,
  Radio,
  UserRound,
} from "lucide-react";

import { compactChannelHistoryWindow } from "@/components/dashboard/channel-history";

import {
  workspaceKey,
} from "@/components/dashboard/agent-workspaces";

import {
  channelTitle,
} from "@/components/dashboard/channel-links";

import {
  type DesktopContext,
} from "@/lib/desktop/bridge";

import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import type {
  AgentRegistrationSummary,
  ChannelMessage,
  ObservabilityEvent,
  SerializedAgent,
  SerializedChannel,
  SerializedMachineDaemon,
  SerializedAutomation,
  SerializedSpace,
  SerializedWorkspace,
  PageSummary,
} from "@xmatrix/protocol";

export function insertMentionIntoDraft(
  draft: string,
  cursor: number,
  mention: string
): { value: string; cursor: number } {
  const target = mention.trim().replace(/^[@＠]/, "");
  if (!target) return { value: draft, cursor };

  const boundedCursor = Math.min(Math.max(cursor, 0), draft.length);
  const beforeCursor = draft.slice(0, boundedCursor);
  const afterCursor = draft.slice(boundedCursor);
  const prefix = beforeCursor && !/\s$/.test(beforeCursor) ? " " : "";
  const insert = `${prefix}@${target} `;
  return {
    value: `${beforeCursor}${insert}${afterCursor}`,
    cursor: beforeCursor.length + insert.length,
  };
}

export function localWorkspacesForDesktop(
  workspaces: SerializedWorkspace[],
  context: DesktopContext | null
): SerializedWorkspace[] {
  const localKeys = machineIdentityKeys({
    machineId: context?.machineId,
  });
  if (localKeys.length === 0) return [];
  return workspaces.filter((workspace) =>
    machineIdentityKeys({
      machineId: workspace.machineId,
    }).some((key) => localKeys.includes(key))
  );
}

/** This Space's registrations whose harness runs on this machine. */
export function buildLocalManagedAgents(
  registrations: AgentRegistrationSummary[],
  context: DesktopContext | null
): LocalManagedAgent[] {
  if (!context?.machineId) return [];
  return registrations
    .filter((registration) => registration.key.machineId === context.machineId)
    .map((registration) => ({ id: registrationTupleId(registration.key), name: registration.displayName,
      harness: registration.key.harness, registration }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
export function buildMachineSummaries(
  daemons: SerializedMachineDaemon[],
  workspaces: SerializedWorkspace[],
  desktopContext: DesktopContext | null
): MachineSummary[] {
  const machines = new Map<string, MachineSummary>();

  const ensureMachine = (keys: string[], name?: string) => {
    const normalizedKeys = normalizedMachineKeys(keys);
    if (!normalizedKeys.length) return undefined;
    const existing = normalizedKeys
      .map((key) => machines.get(key))
      .find((machine): machine is MachineSummary => Boolean(machine));
    if (existing) {
      if (existing.name === "Unnamed machine" && name) existing.name = name;
      for (const key of normalizedKeys) machines.set(key, existing);
      return existing;
    }
    const id = normalizedKeys[0];
    const machine: MachineSummary = {
      id,
      name: name || "Unnamed machine",
      machineId: id,
      status: "offline",
      workspaces: [],
    };
    for (const key of normalizedKeys.length ? normalizedKeys : [id]) machines.set(key, machine);
    return machine;
  };

  for (const workspace of workspaces) {
    const machine = ensureMachine(
      machineIdentityKeys({
        machineId: workspace.machineId,
      })
    );
    if (!machine) continue;
    machine.workspaces.push(workspace);
    machine.lastSeenAt = latestIso(machine.lastSeenAt, workspace.lastSeenAt);
  }

  for (const daemon of daemons) {
    const machine = ensureMachine(
      machineIdentityKeys({
        machineId: daemon.machineId,
      }),
      daemon.machineName
    );
    if (!machine) continue;
    // The owner's name for the Machine outranks whatever label created the entry.
    if (daemon.machineName) machine.name = daemon.machineName;
    if (daemon.machineId) machine.machineId = daemon.machineId;
    if (daemon.parentMachineId) machine.parentMachineId = daemon.parentMachineId;
    if (daemon.autoAssign === false) machine.autoAssign = false;
    if (daemon.activeRuns !== undefined) machine.activeRuns = daemon.activeRuns;
    machine.daemon = preferredMachineDaemon(machine.daemon, daemon);
    machine.daemonVersion =
      daemon.daemonVersion ||
      metadataString(daemon.metadata, "xmatrixDaemonVersion") ||
      machine.daemonVersion;
    machine.cliVersion =
      daemon.cliVersion ||
      metadataString(daemon.metadata, "xmatrixCliVersion") ||
      machine.cliVersion;
    machine.appVersion =
      daemon.appVersion ||
      metadataString(daemon.metadata, "xmatrixAppVersion") ||
      machine.appVersion;
    machine.lastSeenAt = latestIso(machine.lastSeenAt, daemon.lastSeenAt || daemon.connectedAt);
    if (isLiveMachineDaemon(daemon)) {
      machine.status = "online";
    }
  }

  if (desktopContext) {
    const localMachine = ensureMachine(
      machineIdentityKeys({
        machineId: desktopContext.machineId,
      })
    );
    if (localMachine) localMachine.appVersion = desktopContext.version || localMachine.appVersion;
  }

  return Array.from(new Set(machines.values())).sort((left, right) => {
    if (left.status !== right.status) return left.status === "online" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export function latestIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

export function latestTimestamp(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

/** Earliest finite ISO timestamp. Used for stable agent birth order (connectedAt). */
export function earliestTimestamp(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

export function sortSpaces(spaces: SerializedSpace[]): SerializedSpace[] {
  return [...spaces].sort((a, b) => a.name.localeCompare(b.name));
}

export function sortProjects(projects: SerializedWorkspace[]): SerializedWorkspace[] {
  return [...projects].sort((a, b) => {
    const byTime = new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
    if (byTime !== 0) return byTime;
    return a.displayName.localeCompare(b.displayName);
  });
}

export function sortAutomations(automations: SerializedAutomation[]): SerializedAutomation[] {
  return [...automations].sort((a, b) => {
    const byNextRun = timestampMs(a.nextRunAt) - timestampMs(b.nextRunAt);
    if (byNextRun !== 0) return byNextRun;
    return a.name.localeCompare(b.name);
  });
}

export function sortChannels(channels: SerializedChannel[]): SerializedChannel[] {
  return [...channels].sort(compareChannelsForSidebar);
}

export function compareChannelsForSidebar(a: SerializedChannel, b: SerializedChannel): number {
  const leftPinned = channelIsPinned(a);
  const rightPinned = channelIsPinned(b);
  if (leftPinned !== rightPinned) return rightPinned ? 1 : -1;
  if (leftPinned && rightPinned) {
    const byPinnedAt = channelPinnedAtMs(b) - channelPinnedAtMs(a);
    if (byPinnedAt !== 0) return byPinnedAt;
  }
  return compareChannelsByRecentActivity(a, b);
}

/**
 * Ranks Channels newest activity first.
 *
 * Catalog fields come from the Hub, but live history/cache hydration can make
 * `lastMessage.sentAt` newer than the Channel row. Use the latest authoritative
 * message, property-update, or creation timestamp rather than a local cache
 * timestamp.
 */
export function compareChannelsByRecentActivity(
  a: SerializedChannel,
  b: SerializedChannel
): number {
  const byActivity = channelRecentActivityMs(b) - channelRecentActivityMs(a);
  if (byActivity !== 0) return byActivity;
  return channelTitle(a).localeCompare(channelTitle(b));
}

/**
 * A catalog page's loaded rows in the order their own times read.
 *
 * The Hub ranks a page when it is read, but each row then shows its live
 * Channel, whose newest message can be later than that read. Ranking the rows
 * again by that same activity keeps a later time from sitting below an earlier
 * one until the next read. Pinned rows keep the lead the Hub gives them.
 */
export function rankCatalogChannels(
  channels: readonly SerializedChannel[],
  pinnedChannelIds: readonly string[]
): SerializedChannel[] {
  const pinRank = new Map(pinnedChannelIds.map((id, index) => [id, index]));
  const rank = (channel: SerializedChannel) => pinRank.get(channel.id) ?? pinnedChannelIds.length;
  return [...channels].sort((a, b) =>
    rank(a) - rank(b) || channelRecentActivityMs(b) - channelRecentActivityMs(a));
}

export function channelRecentActivityMs(channel: SerializedChannel): number {
  return Math.max(
    timestampMs(channel.lastMessage?.sentAt),
    timestampMs(channel.updatedAt),
    timestampMs(channel.createdAt)
  );
}

export function channelIsPinned(channel: SerializedChannel): boolean {
  const metadata = channel.metadata;
  return (
    metadata?.pinned === true ||
    metadata?.isPinned === true ||
    Boolean(channelPinnedAtMs(channel))
  );
}

export function channelPinnedAtMs(channel: SerializedChannel): number {
  const metadata = channel.metadata;
  const pinnedAt = metadata?.pinnedAt ?? metadata?.pinned_at;
  return typeof pinnedAt === "string" ? timestampMs(pinnedAt) : 0;
}

export function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function isThreadChannel(channel: SerializedChannel): boolean {
  return (
    channel.metadata?.kind === "thread" ||
    Boolean(metadataString(channel.metadata, "threadRootMessageId")) ||
    Boolean(metadataString(channel.metadata, "threadRootChannelId"))
  );
}

/* channelMatchesSearch owned by workspace-shell-search-model */

export function quickOpenChannelSubtitle(
  channel: SerializedChannel,
  spaces: SerializedSpace[],
  channels: SerializedChannel[] = []
): string {
  const space = spaces.find((item) => item.id === channel.spaceId);
  if (isThreadChannel(channel)) {
    const parentId = metadataString(channel.metadata, "threadRootChannelId");
    const parent = parentId ? channels.find((item) => item.id === parentId) : undefined;
    const author = metadataString(channel.metadata, "threadRootAuthor");
    const preview = metadataString(channel.metadata, "threadRootPreview");
    const threadPreview = [author, preview].filter(Boolean).join(": ");
    const parts = [
      parent ? `in #${channelTitle(parent)}` : space?.name || "thread",
      threadPreview || channel.summary || channel.topic,
      channel.updatedAt ? `updated ${relativeTime(channel.updatedAt)}` : undefined,
    ].filter(Boolean);
    return parts.join(" - ");
  }
  const parts = [
    space?.name || "space",
    channel.summary || channel.topic,
    channel.updatedAt ? `updated ${relativeTime(channel.updatedAt)}` : undefined,
  ].filter(Boolean);
  return parts.join(" - ");
}

export function buildWorkspaceSearchResults({
  query,
  channels,
  spaces,
  agents,
  projects,
  machineDaemons,
  events,
  messages,
  pages = [],
}: {
  query: string;
  channels: SerializedChannel[];
  spaces: SerializedSpace[];
  agents: SerializedAgent[];
  projects: SerializedWorkspace[];
  machineDaemons: SerializedMachineDaemon[];
  events: ObservabilityEvent[];
  messages: ChannelMessage[];
  /** Titles of pages this reader can already see. Bodies come from the Hub search. */
  pages?: readonly PageSummary[];
}): WorkspaceSearchResult[] {
  const normalizedQuery = normalizeChannelSearchText(query);
  if (!normalizedQuery) return [];

  const results: WorkspaceSearchResult[] = [];
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const seenMessages = new Set<string>();

  for (const channel of channels) {
    if (!channelMatchesSearch(channel, normalizedQuery)) continue;
    results.push({
      id: `channel:${channel.id}`,
      kind: "channel",
      title: `#${channelTitle(channel)}`,
      subtitle: quickOpenChannelSubtitle(channel, spaces, channels),
      channelId: channel.id,
    });
  }

  // Catalog last-message previews (what the mobile channel list shows under the
  // title) should also surface as message hits so users can jump to them.
  for (const channel of channels) {
    const last = channel.lastMessage;
    if (!last?.messageId || seenMessages.has(last.messageId)) continue;
    const searchable = normalizeChannelSearchText([
      last.bodyPreview,
      last.from?.label,
    ].filter(Boolean).join(" "));
    if (!searchable.includes(normalizedQuery)) continue;
    seenMessages.add(last.messageId);
    results.push({
      id: `message:${last.messageId}`,
      kind: "message",
      title: (last.bodyPreview || "").trim() || "Message",
      subtitle: `${last.from?.label || "Someone"} in #${channelTitle(channel)} - ${formatDateTime(last.sentAt)}`,
      channelId: channel.id,
      messageId: last.messageId,
    });
  }

  for (const message of messages) {
    if (seenMessages.has(message.messageId)) continue;
    const channel = channelById.get(message.channelId);
    const attachmentNames = (message.attachments ?? []).map((attachment) => attachment.name);
    const searchable = normalizeChannelSearchText([
      message.body,
      message.from.label,
      message.from.email,
      ...attachmentNames,
      channel ? channelTitle(channel) : "",
    ].filter(Boolean).join(" "));
    if (!searchable.includes(normalizedQuery)) continue;
    seenMessages.add(message.messageId);
    results.push({
      id: `message:${message.messageId}`,
      kind: "message",
      title: message.body.trim() || attachmentNames.find((name) => name.trim()) || "Attachment",
      subtitle: `${message.from.label} in #${channel ? channelTitle(channel) : shortId(message.channelId)} - ${formatDateTime(message.sentAt)}`,
      channelId: message.channelId,
      messageId: message.messageId,
    });
  }

  for (const page of pages) {
    if (!normalizeChannelSearchText(page.title).includes(normalizedQuery)) continue;
    results.push({
      id: `page:${page.pageId}`,
      kind: "page",
      title: page.title,
      subtitle: "Page",
      pageId: page.pageId,
    });
  }

  for (const space of spaces) {
    for (const member of space.members) {
      const title = member.name?.trim() || member.handle?.trim() || member.email?.trim() || shortId(member.userId);
      const searchable = normalizeChannelSearchText([
        member.name,
        member.email,
        member.handle,
        member.handle ? `@${member.handle}` : undefined,
        member.role,
      ].filter(Boolean).join(" "));
      if (!searchable.includes(normalizedQuery)) continue;
      const extra = [
        member.email && member.email !== title ? member.email : undefined,
        member.handle && member.handle !== title ? `@${member.handle}` : undefined,
      ].filter(Boolean);
      results.push({
        id: `member:${space.id}:${member.userId}`,
        kind: "member",
        title,
        subtitle: [`${member.role} in ${space.name}`, ...extra].join(" · "),
        userId: member.userId,
        spaceId: space.id,
      });
    }
  }

  for (const agent of agents) {
    const searchable = normalizeChannelSearchText([
      agent.name,
      agent.email,
      agent.status,
      agent.activity,
      agent.id,
    ].filter(Boolean).join(" "));
    if (!searchable.includes(normalizedQuery)) continue;
    results.push({
      id: `agent:${agent.id}`,
      kind: "agent",
      title: agent.name,
      subtitle: [agent.status, agent.activity, agent.email].filter(Boolean).join(" - "),
    });
  }

  for (const space of spaces) {
    const searchable = normalizeChannelSearchText([space.name, space.id].join(" "));
    if (!searchable.includes(normalizedQuery)) continue;
    const channel = channels.find((item) => item.spaceId === space.id);
    results.push({
      id: `space:${space.id}`,
      kind: "space",
      title: space.name,
      subtitle: "Space",
      channelId: channel?.id,
    });
  }

  for (const project of projects) {
    const searchable = normalizeChannelSearchText([
      project.displayName,
      project.hostName,
      project.hostId,
      project.canonicalCwd,
    ].filter(Boolean).join(" "));
    if (!searchable.includes(normalizedQuery)) continue;
    results.push(workspaceSearchResult(project));
  }

  for (const daemon of machineDaemons) {
    const hostName = daemon.hostName || metadataString(daemon.metadata, "hostName");
    const searchable = normalizeChannelSearchText([
      daemon.name,
      daemon.status,
      daemon.activity,
      daemon.machineId,
      daemon.hostId,
      hostName,
    ].filter(Boolean).join(" "));
    if (!searchable.includes(normalizedQuery)) continue;
    results.push(machineSearchResult(daemon));
  }

  for (const event of events) {
    const channel = event.channelId ? channelById.get(event.channelId) : undefined;
    const searchable = normalizeChannelSearchText([
      event.type,
      event.agentName,
      event.channelId,
      eventMetadataString(event, "summary"),
    ].filter(Boolean).join(" "));
    if (!searchable.includes(normalizedQuery)) continue;
    results.push({
      id: `event:${event.id}`,
      kind: "event",
      title: eventLabel(event),
      subtitle: `${channel ? `#${channelTitle(channel)} - ` : ""}${formatDateTime(event.timestamp)}`,
      channelId: event.channelId,
    });
  }

  return results
    .sort((left, right) =>
      searchResultRank(left.kind) - searchResultRank(right.kind) || left.id.localeCompare(right.id)
    )
    .slice(0, 80);
}

export function searchResultIcon(kind: WorkspaceSearchResult["kind"]): React.ComponentType<{ className?: string }> {
  if (kind === "channel") return Hash;
  if (kind === "page") return FileText;
  if (kind === "member") return UserRound;
  if (kind === "message") return MessageSquare;
  if (kind === "agent") return Bot;
  if (kind === "space") return Building;
  if (kind === "machine") return HardDrive;
  return Radio;
}

export function scrollActiveCommandResultIntoView(element: HTMLButtonElement | null | undefined) {
  element?.scrollIntoView({ block: "nearest" });
}

export function latestSequence(messages: ChannelMessage[]): number {
  return messages.reduce((max, message) => Math.max(max, message.sequence || 0), 0);
}

export function earliestPositiveSequence(messages: ChannelMessage[]): number | undefined {
  let earliest = Number.POSITIVE_INFINITY;
  for (const message of messages) {
    if (message.sequence === undefined || !Number.isSafeInteger(message.sequence) || message.sequence < 1) {
      continue;
    }
    earliest = Math.min(earliest, message.sequence);
  }
  return Number.isFinite(earliest) ? earliest : undefined;
}

export function historyMessageCountEstimate(messages: ChannelMessage[]): number {
  return Math.max(latestSequence(messages), messages.length);
}

export function latestHistorySentAt(messages: ChannelMessage[]): string | undefined {
  return latestHistoryEntry(messages)?.sentAt;
}

export function latestHistoryEntry(messages: ChannelMessage[]): ChannelMessage | undefined {
  return messages.reduce<ChannelMessage | undefined>((latest, message) => {
    if (!latest) return message;
    const bySequence = (message.sequence || 0) - (latest.sequence || 0);
    if (bySequence !== 0) return bySequence > 0 ? message : latest;
    return timestampMs(message.sentAt) >= timestampMs(latest.sentAt) ? message : latest;
  }, undefined);
}

export function isOwnChannelMessage(message: ChannelMessage, userId: string): boolean {
  return (
    message.from.kind === "user" &&
    (message.from.userId === userId || message.from.identityId === `user:${userId}`)
  );
}

export function channelUnreadCount(
  channel: SerializedChannel,
  readCounts: Record<string, number>,
  readCountsBaselineReady: boolean
): number {
  if (channel.messageCount === undefined) return 0;
  const readCount = channel.readSequence
    ?? readCounts[channel.id]
    ?? (readCountsBaselineReady ? 0 : channel.messageCount);
  return Math.max(0, channel.messageCount - readCount);
}

function unreadAttentionIsMention(
  attention: SerializedChannel["attention"],
): boolean {
  if (!attention || attention.unreadAttentionCount <= 0) return false;
  if (attention.triggerKinds?.includes("mention")) return true;
  if (attention.primaryTriggerKind === "mention") return true;
  // Older summaries named the count but not the kind; treat those as @.
  return !attention.primaryTriggerKind && (!attention.triggerKinds || attention.triggerKinds.length === 0);
}

export function channelHasUnreadMention(
  channel: SerializedChannel,
  events: readonly ObservabilityEvent[],
  mentionClearedAt: Record<string, number>,
  unreadCount: number
): boolean {
  if (channel.attention) return unreadAttentionIsMention(channel.attention);
  if (unreadCount <= 0) return false;
  return latestChannelMentionTimestampMs(channel.id, events) > (mentionClearedAt[channel.id] || 0);
}

export function channelUnreadMentionJumpId(
  channel: SerializedChannel,
  events: readonly ObservabilityEvent[],
  mentionClearedAt: Record<string, number>,
  unreadCount: number,
): string | undefined {
  if (!channelHasUnreadMention(channel, events, mentionClearedAt, unreadCount)) return undefined;
  return channel.attention?.lastMessageId;
}

export function latestChannelMentionTimestampMs(channelId: string, events: readonly ObservabilityEvent[]): number {
  let latest = 0;
  for (const event of events) {
    if (event.type !== "channel_mention" || event.channelId !== channelId) continue;
    // Who sent the `@` does not change whether you were asked for. The Hub's
    // attention summary counts an Agent's mention like a human's, and this
    // fallback has to agree with it.
    latest = Math.max(latest, timestampMs(event.timestamp));
  }
  return latest;
}

export function compactChannelHistoryCacheInPlace(cache: Map<string, ChannelHistoryCacheEntry>): void {
  const compacted = compactChannelHistoryCache(cache);
  cache.clear();
  for (const [channelId, entry] of compacted) cache.set(channelId, entry);
}

export function compactChannelHistoryCache(
  cache: Map<string, ChannelHistoryCacheEntry>
): Map<string, ChannelHistoryCacheEntry> {
  const now = Date.now();
  const entries = Array.from(cache.entries())
    .map(([channelId, entry]) => {
      const compacted = compactChannelHistoryWindow(
        channelId,
        entry.messages,
        entry.hasOlderMessages,
        CHANNEL_HISTORY_CACHE_MAX_MESSAGES,
      );
      return [
        channelId,
        {
          ...compacted,
          cachedAt: entry.cachedAt || now,
        },
      ] as const;
    })
    .filter(([, entry]) =>
      entry.messages.length > 0 && now - entry.cachedAt <= CHANNEL_HISTORY_CACHE_MAX_AGE_MS
    )
    .sort((left, right) => right[1].cachedAt - left[1].cachedAt)
    .slice(0, CHANNEL_HISTORY_CACHE_MAX_CHANNELS);

  return new Map(entries);
}

export function readChannelReadCounts(userId: string): Record<string, number> {
  if (typeof window === "undefined") return {};

  try {
    const raw = window.localStorage.getItem(channelReadCountsStorageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const counts: Record<string, number> = {};
    for (const [channelId, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        counts[channelId] = value;
      }
    }
    return counts;
  } catch {
    return {};
  }
}

export function writeChannelReadCounts(userId: string, readCounts: Record<string, number>) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      channelReadCountsStorageKey(userId),
      JSON.stringify(readCounts)
    );
  } catch {
    // Losing a local read cursor is non-fatal; the channel list will still render.
  }
}

export function workingSpaceStorageKey(userId: string): string {
  return `${WORKING_SPACE_STORAGE_PREFIX}${userId}`;
}

export function readWorkingSpaceCache(userId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(workingSpaceStorageKey(userId));
    return raw && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Whether the loaded Space list can be treated as authoritative for the signed-in
 * user. Keyed to the user rather than to the access token: the workspace load
 * effect also re-enters on the focus/visibility JWT mint, and retracting
 * authority per token would reopen the cold-start mirror window on every
 * rotation. A different user has no authority here until their own load lands.
 */
export function spacesAuthorityReady(
  spacesLoadedUserId: string | null,
  authenticatedUserId: string | null
): boolean {
  return Boolean(authenticatedUserId) && spacesLoadedUserId === authenticatedUserId;
}

/**
 * Which Space the shell is in. Every branch but the last is authority-checked
 * against the loaded Space list.
 *
 * The last one exists because cold start paints the durable channel catalog
 * before /spaces answers, and the channel list falls back to *every* Space when
 * it has no Space id — that cross-Space mixture is the scrambled first frame.
 * During that window the localStorage working-Space mirror holds the id /spaces
 * is about to confirm, so scope to it rather than to everything.
 *
 * `spacesLoaded` — not `spaces.length` — closes that window. An authoritative
 * empty list is still an answer: once it arrives, a mirror pointing at a Space
 * the user can no longer reach must stop winning, or it would pin the shell to
 * a dead Space id for the rest of the session.
 */
export function resolveCurrentSpaceId({
  pendingExplicitSpaceId,
  routeSpaceId,
  workingSpaceId,
  selectedChannelSpaceId,
  spaces,
  spacesLoaded,
}: {
  pendingExplicitSpaceId: string | null;
  routeSpaceId: string | null;
  workingSpaceId: string | null;
  selectedChannelSpaceId: string | null;
  spaces: SerializedSpace[];
  spacesLoaded: boolean;
}): string | null {
  const loaded = (id: string | null) => Boolean(id) && spaces.some((space) => space.id === id);
  return (
    (loaded(pendingExplicitSpaceId) ? pendingExplicitSpaceId : null) ||
    routeSpaceId ||
    (loaded(workingSpaceId) ? workingSpaceId : null) ||
    selectedChannelSpaceId ||
    spaces[0]?.id ||
    (spacesLoaded ? null : workingSpaceId) ||
    null
  );
}

export function writeWorkingSpaceCache(userId: string, spaceId: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(workingSpaceStorageKey(userId), spaceId);
  } catch {
    // a lost working-space hint just falls back to the first space
  }
}

export async function persistWorkingSpace(
  token: string,
  spaceId: string,
  transport: typeof globalThis.fetch,
): Promise<void> {
  try {
    await transport(WEB_PROXY_ROUTES.shared_memory, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ key: WORKING_SPACE_KV_KEY, value: spaceId }),
      cache: "no-store",
    });
  } catch {
    // best-effort; the localStorage mirror still carries it on this device
  }
}

export function readChannelMentionClearedAt(userId: string): Record<string, number> {
  if (typeof window === "undefined") return {};

  try {
    const raw = window.localStorage.getItem(channelMentionClearedStorageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const clearedAt: Record<string, number> = {};
    for (const [channelId, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        clearedAt[channelId] = value;
      }
    }
    return clearedAt;
  } catch {
    return {};
  }
}

export function writeChannelMentionClearedAt(userId: string, clearedAt: Record<string, number>) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      channelMentionClearedStorageKey(userId),
      JSON.stringify(clearedAt)
    );
  } catch {
    // Losing local mention acknowledgement only affects sidebar badge color.
  }
}

export function channelMentionClearedStorageKey(userId: string): string {
  return `${CHANNEL_MENTION_CLEARED_STORAGE_PREFIX}${userId}`;
}

/* Channel pins are durable in Authority (see `useChannelViewPreference`). The
   browser-local store that used to hold them is deliberately gone: its
   compaction pass deleted a Human's pins whenever the in-memory channel list
   was momentarily incomplete, and a second copy of the same fact could only
   re-introduce that. */

export function workspaceSearchResult(project: SerializedWorkspace): WorkspaceSearchResult {
  return {
    id: `workspace:${workspaceKey(project)}`, kind: "machine", title: project.displayName,
    subtitle: [project.hostName || project.hostId, project.canonicalCwd].filter(Boolean).join(" - "),
  };
}

export function machineSearchResult(daemon: SerializedMachineDaemon): WorkspaceSearchResult {
  const hostName = daemon.hostName || metadataString(daemon.metadata, "hostName");
  return {
    id: `machine:${daemon.id}`, kind: "machine", title: daemon.name,
    subtitle: [daemon.status, daemon.activity, hostName || daemon.hostId].filter(Boolean).join(" - "),
  };
}
