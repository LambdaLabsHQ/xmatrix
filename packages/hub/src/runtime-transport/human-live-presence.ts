import type { ChannelMemberPresence, SerializedChannel } from "@xmatrix/protocol";

/**
 * Process-memory Human presence snapshot for RelayRuntime product sockets.
 * Product authority stays in Authority; this only describes live authenticated sessions.
 */
export interface LiveHumanSessionSnapshot {
  userId: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  lastSeenAt: string;
  focusedChannelId: string | null;
  /** Room-parity device instance for memberPresence.instances */
  deviceClient?: string;
  deviceLabel?: string;
  platform?: string;
}

export interface LiveHumanSessionSource {
  user: {
    id: string;
    email?: string;
    name?: string;
    avatarUrl?: string;
  };
  lastSeenAt: string;
  focusedChannelId: string | null;
  deviceClient?: string;
  deviceLabel?: string;
  platform?: string;
}

export type OpenChannelHumanMemberIdsBySpace = Readonly<
  Record<string, readonly string[]>
>;

export function liveHumanSessionSnapshots(
  sessions: Iterable<LiveHumanSessionSource>,
): LiveHumanSessionSnapshot[] {
  return Array.from(sessions, (session) => ({
    userId: session.user.id,
    ...(session.user.email ? { email: session.user.email } : {}),
    ...(session.user.name ? { name: session.user.name } : {}),
    ...(session.user.avatarUrl ? { avatarUrl: session.user.avatarUrl } : {}),
    lastSeenAt: session.lastSeenAt,
    focusedChannelId: session.focusedChannelId,
    ...(session.deviceClient ? { deviceClient: session.deviceClient } : {}),
    ...(session.deviceLabel ? { deviceLabel: session.deviceLabel } : {}),
    ...(session.platform ? { platform: session.platform } : {}),
  }));
}

export function buildHumanMemberPresenceForChannel(
  visibleHumanMemberIds: readonly string[],
  sessions: readonly LiveHumanSessionSnapshot[],
  channelId: string,
): Record<string, ChannelMemberPresence> {
  const sessionsByUserId = new Map<string, LiveHumanSessionSnapshot[]>();
  for (const session of sessions) {
    const userId = session.userId.startsWith("user:")
      ? session.userId.slice("user:".length)
      : session.userId;
    const list = sessionsByUserId.get(userId) || [];
    list.push(session);
    sessionsByUserId.set(userId, list);
  }

  const presence: Record<string, ChannelMemberPresence> = {};
  for (const userId of visibleHumanUserIds(visibleHumanMemberIds)) {
    const memberId = `user:${userId}`;
    const userSessions = sessionsByUserId.get(userId) || [];
    if (userSessions.length === 0) continue;
    const latest = [...userSessions].sort((left, right) =>
      right.lastSeenAt.localeCompare(left.lastSeenAt)
    )[0];
    // Room-era listing only surfaced labeled device instances (client without
    // label is still online at the member level, but not a named instance row).
    const instances = userSessions
      .filter((session) => Boolean(session.deviceLabel?.trim()))
      .map((session, index) => ({
        id: `human:${userId}:${session.deviceClient || "device"}:${index}`,
        status: "online" as const,
        label: session.deviceLabel!.trim(),
        hostName: session.deviceClient || session.platform || "web",
        connectedAt: session.lastSeenAt,
        lastSeenAt: session.lastSeenAt,
        ...(session.platform ? { platform: session.platform } : {}),
      }));
    // Runtime presence reports liveness only. Human identity and offline
    // membership come from the product directory, so omit offline rows.
    const label = latest?.name || latest?.email;
    presence[memberId] = {
      kind: "user",
      status: "online",
      focused: userSessions.some((session) => session.focusedChannelId === channelId),
      ...(label ? { label } : {}),
      ...(latest?.email ? { email: latest.email } : {}),
      ...(latest?.avatarUrl ? { avatarUrl: latest.avatarUrl } : {}),
      ...(latest?.lastSeenAt ? { lastSeenAt: latest.lastSeenAt } : {}),
      instances,
    };
  }
  return presence;
}

export function visibleHumanUserIds(visibleHumanMemberIds: readonly string[]): string[] {
  const userIds = new Set<string>();
  for (const memberId of visibleHumanMemberIds) {
    if (!memberId.startsWith("user:")) continue;
    const userId = memberId.slice("user:".length);
    if (userId) userIds.add(userId);
  }
  return Array.from(userIds);
}

export function humanMemberIdsForChannel(
  channel: Pick<SerializedChannel, "mode" | "spaceId" | "visibleHumanMemberIds">,
  openChannelHumanMemberIdsBySpace: OpenChannelHumanMemberIdsBySpace,
): readonly string[] {
  return channel.mode === "open"
    ? openChannelHumanMemberIdsBySpace[channel.spaceId] || []
    : channel.visibleHumanMemberIds || [];
}

export function overlayHumanPresenceOnChannel(
  channel: SerializedChannel,
  sessions: readonly LiveHumanSessionSnapshot[],
  humanMemberIds: readonly string[],
): SerializedChannel {
  const humanPresence = buildHumanMemberPresenceForChannel(
    humanMemberIds,
    sessions,
    channel.id,
  );
  return {
    ...channel,
    memberPresence: {
      ...channel.memberPresence,
      ...humanPresence,
    },
  };
}

/**
 * A presence update is shared with every authorized Human in the Channel.
 * `get-channel` is necessarily read as one concrete Human, so its result also
 * carries that reader's private projection. Never let those fields hitch a
 * ride on the shared update: clients merge-preserve their own copy when the
 * partial payload omits them.
 */
export function channelForSharedPresenceFanout(
  channel: SerializedChannel,
): SerializedChannel {
  const {
    attention: _viewerAttention,
    readSequence: _viewerReadSequence,
    ...shared
  } = channel;
  return shared;
}

/**
 * The Channels whose Human Presence a change alters. A focus change moves one
 * Human's `focused` mark from the Channel they left to the one they opened, so
 * only those two change. A connect or disconnect changes that Human's online
 * state wherever they are a member, so every Channel a live Human is looking
 * at is refreshed as well.
 */
export function channelIdsNeedingHumanPresenceFanout(
  reason: "connect" | "focus" | "disconnect",
  previousFocusedChannelId: string | null | undefined,
  nextFocusedChannelId: string | null | undefined,
  liveFocusedChannelIds: readonly (string | null | undefined)[],
): string[] {
  const ids = new Set<string>();
  const watched = reason === "focus" ? [] : liveFocusedChannelIds;
  for (const channelId of [previousFocusedChannelId, nextFocusedChannelId, ...watched]) {
    if (typeof channelId === "string" && channelId.trim()) ids.add(channelId.trim());
  }
  return Array.from(ids);
}
