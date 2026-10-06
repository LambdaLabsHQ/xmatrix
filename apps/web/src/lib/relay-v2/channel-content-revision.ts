/**
 * Session registry of the newest channel contentRevision this client has
 * APPLIED — from a live history response, or from admitting a persisted tail
 * that was stamped with one. The Hub bumps a channel's contentRevision
 * whenever the bytes of already-served history can change (edit, recall,
 * redaction, archive drain) and never on append, so a cached tail stamped at
 * one revision is provably stale the moment the catalog carries another.
 * This applied registry is distinct from the catalog row's server-current
 * `contentAuthority` (read via channelCatalogContentRevision): admission
 * compares the two for exact equality. Absence of a revision (older Hub,
 * WS-only session) simply yields no signal.
 */

const CHANNEL_CONTENT_PROTOCOL_VERSION = 1;

const latestRevisions = new Map<string, number>();

export function parseChannelContentRevision(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const authority = value as { protocolVersion?: unknown; contentRevision?: unknown };
  if (authority.protocolVersion !== CHANNEL_CONTENT_PROTOCOL_VERSION) return undefined;
  const revision = authority.contentRevision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    return undefined;
  }
  return revision;
}

export function noteChannelContentRevision(
  channelId: string,
  revision: number | undefined,
): void {
  if (revision === undefined) return;
  latestRevisions.set(channelId, revision);
}

export function latestChannelContentRevision(channelId: string): number | undefined {
  return latestRevisions.get(channelId);
}

/** Server-current revision as carried on a catalog channel row's
 * `contentAuthority`; undefined (older Hub, malformed) is no signal. */
export function channelCatalogContentRevision(
  channel: { contentAuthority?: unknown },
): number | undefined {
  return parseChannelContentRevision(channel.contentAuthority);
}
