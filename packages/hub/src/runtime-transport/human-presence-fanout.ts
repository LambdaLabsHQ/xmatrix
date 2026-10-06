import type { HumanServerMessage } from "@xmatrix/protocol/connections/human";
import type { SerializedChannel } from "@xmatrix/protocol";
import { getChannel, type SpacesEnv } from "../spaces";
import {
  channelForSharedPresenceFanout,
  channelIdsNeedingHumanPresenceFanout,
  humanMemberIdsForChannel,
  overlayHumanPresenceOnChannel,
  visibleHumanUserIds,
  type OpenChannelHumanMemberIdsBySpace,
  type LiveHumanSessionSnapshot,
} from "./human-live-presence";
import type { HumanPresenceChangeHandler } from "./human-port";
import { overlayChannelsWithLiveAgentPresence } from "./agent-presence-snapshot";
import { loadRuntimePresenceSnapshotEntries, tryLoadRuntimePresenceSnapshotEntries } from "./runtime-presence-snapshot";

export const RELAY_RUNTIME_HUMAN_PRESENCE_PATH = "/internal/human-presence";

/**
 * Build a Human presence change handler that rehydrates Authority channel snapshots
 * with live Runtime Human and Agent sessions and fans out channel_updated messages.
 */
export function createHumanPresenceFanout(input: {
  readChannel: HumanFanoutChannelReader;
}): HumanPresenceChangeHandler {
  return async ({
    reason,
    previousFocusedChannelId,
    nextFocusedChannelId,
    session,
    liveSessions,
    liveAgentSessions,
    deliver,
  }) => {
    const channelIds = channelIdsNeedingHumanPresenceFanout(
      reason,
      previousFocusedChannelId,
      nextFocusedChannelId,
      liveSessions.map((candidate) => candidate.focusedChannelId),
    );
    if (channelIds.length === 0) return;

    await Promise.all(channelIds.map(async (channelId) => {
      const principalUserId = presencePrincipalForChannel(
        channelId,
        session.user.id,
        liveSessions,
      );
      const snapshot = await input.readChannel(channelId, principalUserId, "human-presence");
      if (!snapshot) return;
      const humanMemberIds = humanMemberIdsForChannel(
        snapshot.channel,
        snapshot.openChannelHumanMemberIdsBySpace,
      );
      const [agentOverlaid] = overlayChannelsWithLiveAgentPresence(
        [snapshot.channel],
        liveAgentSessions,
      );
      const overlaid = overlayHumanPresenceOnChannel(
        agentOverlaid as SerializedChannel,
        liveSessions,
        humanMemberIds,
      );
      const message: HumanServerMessage = {
        type: "channel_updated",
        channel: channelForSharedPresenceFanout(overlaid),
      };
      for (const userId of visibleHumanUserIds(humanMemberIds)) {
        if (liveSessions.some((candidate) => candidate.userId === userId)) {
          deliver(userId, message);
        }
      }
    }));
  };
}

export async function loadLiveHumanPresenceFromRuntime(
  runtime: { fetch(request: Request): Promise<Response> },
  requestUrl: string,
): Promise<LiveHumanSessionSnapshot[]> {
  const entries = await loadRuntimePresenceSnapshotEntries(
    runtime,
    new URL(RELAY_RUNTIME_HUMAN_PRESENCE_PATH, requestUrl),
  );
  return parseHumanPresence(entries);
}

export async function tryLoadLiveHumanPresenceFromRuntime(
  runtime: { fetch(request: Request): Promise<Response> },
  requestUrl: string,
  timeoutMs: number,
): Promise<LiveHumanSessionSnapshot[] | null> {
  const entries = await tryLoadRuntimePresenceSnapshotEntries(runtime,
    new URL(RELAY_RUNTIME_HUMAN_PRESENCE_PATH, requestUrl), timeoutMs);
  return entries === null ? null : parseHumanPresence(entries);
}

function parseHumanPresence(entries: unknown[]): LiveHumanSessionSnapshot[] {
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.userId !== "string" || !record.userId.trim()) return [];
    if (typeof record.lastSeenAt !== "string" || !record.lastSeenAt.trim()) return [];
    if (!(record.focusedChannelId === null || typeof record.focusedChannelId === "string")) return [];
    return [{
      userId: record.userId,
      ...(typeof record.email === "string" ? { email: record.email } : {}),
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.avatarUrl === "string" ? { avatarUrl: record.avatarUrl } : {}),
      lastSeenAt: record.lastSeenAt,
      focusedChannelId: record.focusedChannelId,
      ...(typeof record.deviceClient === "string" ? { deviceClient: record.deviceClient } : {}),
      ...(typeof record.deviceLabel === "string" ? { deviceLabel: record.deviceLabel } : {}),
      ...(typeof record.platform === "string" ? { platform: record.platform } : {}),
    } satisfies LiveHumanSessionSnapshot];
  });
}

export function overlayChannelsWithLiveHumanPresence(
  channels: readonly unknown[],
  sessions: readonly LiveHumanSessionSnapshot[],
  openChannelHumanMemberIdsBySpace: OpenChannelHumanMemberIdsBySpace,
): unknown[] {
  return channels.map((channel) => {
    if (!channel || typeof channel !== "object" || Array.isArray(channel)) return channel;
    const serializedChannel = channel as SerializedChannel;
    return overlayHumanPresenceOnChannel(
      serializedChannel,
      sessions,
      humanMemberIdsForChannel(serializedChannel, openChannelHumanMemberIdsBySpace),
    );
  });
}

function presencePrincipalForChannel(
  channelId: string,
  actorUserId: string,
  liveSessions: readonly LiveHumanSessionSnapshot[],
): string {
  const focused = liveSessions.find((session) => session.focusedChannelId === channelId);
  return focused?.userId || actorUserId;
}

/** Which live fanout reads a Channel; it names the read in database observation. */
export type HumanFanoutPurpose = "human-presence" | "agent-presence" | "registration-quota" | "member-read";

/**
 * A Channel as one Human reads it, with the hint naming an open Channel's
 * Human members; undefined when that Human cannot read it.
 */
export type HumanFanoutChannelReader = (channelId: string, userId: string, purpose: HumanFanoutPurpose) => Promise<{
  channel: SerializedChannel;
  openChannelHumanMemberIdsBySpace: OpenChannelHumanMemberIdsBySpace;
} | undefined>;

/** Fanout is best effort: a Channel that cannot be read is skipped, never fatal. */
export function humanFanoutChannelReader(env: SpacesEnv): HumanFanoutChannelReader {
  return async (channelId, userId, purpose) => {
    try {
      const read = await getChannel(env, { channelId, principal: { kind: "user", id: userId },
        purpose: `fanout.${purpose}` }) as {
        channel?: SerializedChannel;
        openChannelHumanMemberIdsBySpace?: OpenChannelHumanMemberIdsBySpace;
      };
      if (!read.channel || typeof read.channel.id !== "string") return undefined;
      return {
        channel: read.channel,
        openChannelHumanMemberIdsBySpace: read.openChannelHumanMemberIdsBySpace || {},
      };
    } catch {
      return undefined;
    }
  };
}
