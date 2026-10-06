/**
 * Live Human presence for responses that carry one Channel.
 *
 * Authority serializes durable Agent presence only; a live Human exists solely
 * as a RelayRuntime session and is overlaid at the Hub read boundary. The
 * catalog listing, paging and resolve routes already complete their projection
 * that way. Every route that answers with a single Channel — create, direct,
 * configure, archive, unarchive, join, worktree — handed back the Agent half
 * alone, and clients replace `memberPresence` wholesale, so one such response
 * read as "every Human in this Channel is offline" until the next presence
 * fanout happened to repair it.
 *
 * Same source as the catalog routes: the Runtime read starts before the
 * Channel read so completing presence costs no extra round trip, and a
 * Runtime that cannot be reached degrades to the Agent-only projection.
 */
import type { Env } from "./types";
import { getRelayRuntime } from "./index-shared";
import { getChannel } from "./spaces";
import {
  loadLiveHumanPresenceFromRuntime,
  overlayChannelsWithLiveHumanPresence,
} from "./runtime-transport/human-presence-fanout";
import type {
  LiveHumanSessionSnapshot,
  OpenChannelHumanMemberIdsBySpace,
} from "./runtime-transport/human-live-presence";

export type LiveHumanPresenceRead = Promise<readonly LiveHumanSessionSnapshot[]>;

/**
 * The Hub services this helper reaches: the RelayRuntime binding and the
 * Channel read. Production uses the real ones; tests pass their own boundary
 * instead of rewriting module resolution.
 */
export interface ChannelPresenceBoundary {
  getRelayRuntime: typeof getRelayRuntime;
  getChannel: typeof getChannel;
}

const hubBoundary: ChannelPresenceBoundary = { getRelayRuntime, getChannel };

/** Start the Runtime read first; await it only once the Channel is in hand. */
export function beginLiveHumanPresenceRead(
  env: Env,
  requestUrl: string,
  boundary: ChannelPresenceBoundary = hubBoundary,
): LiveHumanPresenceRead {
  return loadLiveHumanPresenceFromRuntime(boundary.getRelayRuntime(env), requestUrl);
}

/**
 * What a `get-channel` read answers: the Channel plus the Hub-internal hint
 * naming an open Channel's Human members. The hint never reaches a client.
 */
export type ChannelReadPayload = Readonly<Record<string, unknown>>;

export async function channelWithLiveHumanPresence(
  read: ChannelReadPayload,
  sessions: LiveHumanPresenceRead,
): Promise<unknown> {
  const [channel] = await channelReadsWithLiveHumanPresence([read], sessions);
  return channel;
}

/** Several reads of one tree share a Space; their hints merge into one. */
export async function channelReadsWithLiveHumanPresence(
  reads: readonly ChannelReadPayload[],
  sessions: LiveHumanPresenceRead,
): Promise<unknown[]> {
  const hint: Record<string, readonly string[]> = {};
  for (const read of reads) Object.assign(hint, memberHint(read));
  return overlayChannelsWithLiveHumanPresence(
    reads.map((read) => read.channel),
    await sessions,
    hint,
  );
}

function memberHint(read: ChannelReadPayload): OpenChannelHumanMemberIdsBySpace {
  const hint = read.openChannelHumanMemberIdsBySpace;
  return hint && typeof hint === "object" && !Array.isArray(hint)
    ? hint as OpenChannelHumanMemberIdsBySpace
    : {};
}

/**
 * A mutation answers with the Channel it committed but without the member
 * hint. Re-read it as the actor so the response is the same complete
 * projection a catalog read gives; if that read fails, the committed Channel
 * still goes back exactly as before, Agent-only.
 */
export async function committedChannelWithLiveHumanPresence(input: {
  env: Env;
  channelId: string;
  principal: { kind: "user"; id: string };
  committed: unknown;
  sessions: LiveHumanPresenceRead;
  boundary?: ChannelPresenceBoundary;
}): Promise<unknown> {
  const read = await (input.boundary ?? hubBoundary).getChannel(input.env, {
    channelId: input.channelId, principal: input.principal,
  }).catch(() => undefined);
  return channelWithLiveHumanPresence(
    read?.channel && typeof read.channel === "object" ? read : { channel: input.committed },
    input.sessions,
  );
}
