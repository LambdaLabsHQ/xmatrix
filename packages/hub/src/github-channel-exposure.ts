import { PostgresGovernanceRepository } from "@xmatrix/db";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { record, text } from "./github-subscription-domain";
import { getChannel } from "./spaces";
import type { Env } from "./types";

/*
 * Whether content of a GitHub repository may be posted into a Channel.
 *
 * A public repository's events may go anywhere the Space's connection reaches.
 * A private repository's (or one whose privacy GitHub did not state) may go
 * only where people outside the Space's invited members cannot read it: a
 * closed Channel, or an open one in a Space that is not open to participants
 * (docs/design/open-project-governance.md §2: a participant reads the Space's
 * open conversations). Anything that cannot be established counts as public,
 * so a missing or failed read never lets private content out.
 */

export interface ChannelExposureReader {
  /** The Channel as the given user may read it. */
  channel(channelId: string, userId: string): Promise<unknown>;
  /** Whether the Space is open to participants. */
  openParticipation(spaceId: string): Promise<boolean>;
}

export function channelExposureReader(env: Env): ChannelExposureReader {
  return {
    channel: async (channelId, userId) =>
      (await getChannel(env, { channelId, principal: { kind: "user", id: userId } })).channel,
    openParticipation: async (spaceId) => (await new PostgresGovernanceRepository(
      createPostgresAuthorityDatabase(env, {
        applicationName: "xmatrix-github-channel-exposure", statementTimeoutMs: 5_000,
        transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
      })).read({ requestId: crypto.randomUUID(), spaceId })).openParticipation,
  };
}

/** Whether the Space may be read by participants; unknown counts as yes. */
export async function spaceMayBePublic(reader: ChannelExposureReader, spaceId: string): Promise<boolean> {
  try {
    return (await reader.openParticipation(spaceId)) !== false;
  } catch {
    return true;
  }
}

/** Whether a private repository's content may be posted into the Channel. */
export async function channelMayCarryPrivateGitHubContent(
  reader: ChannelExposureReader,
  input: { channelId: string; userId: string },
): Promise<boolean> {
  let channel: Record<string, unknown>;
  try {
    channel = record(await reader.channel(input.channelId, input.userId));
  } catch {
    return false;
  }
  if (channel.mode === "closed") return true;
  const spaceId = text(channel.spaceId);
  if (channel.mode !== "open" || !spaceId) return false;
  return !await spaceMayBePublic(reader, spaceId);
}

/** Whether this repository's content may be posted into the Channel. */
export async function githubContentAllowedInChannel(
  reader: ChannelExposureReader,
  input: { repositoryPublic: boolean; channelId: string; userId: string },
): Promise<boolean> {
  return input.repositoryPublic || channelMayCarryPrivateGitHubContent(reader, input);
}
