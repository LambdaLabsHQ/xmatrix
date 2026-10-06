import type { SerializedChannel, SerializedSpace } from "@xmatrix/protocol";

export type InternalChannelLink = {
  spaceKey: string | null;
  channelKey: string;
  messageId?: string;
};

export function absoluteChannelUrl(
  channel: SerializedChannel,
  spaces: SerializedSpace[],
  origin = typeof window === "undefined" ? "https://xmatrix.sh" : window.location.origin
): string {
  return new URL(channelAppPath(channel, spaces), origin).toString();
}

export function channelAppPath(channel: SerializedChannel, spaces: SerializedSpace[]): string {
  return `${spaceAppPath(channel.spaceId, spaces)}/channels/${encodeURIComponent(
    channelRouteKey(channel)
  )}`;
}

export function spaceAppPath(spaceId: string, spaces: SerializedSpace[]): string {
  const space = spaces.find((item) => item.id === spaceId);
  return `/app/${encodeURIComponent(spaceRouteKey(space, spaceId))}`;
}

export function spaceRouteKey(space: SerializedSpace | undefined, fallbackId: string): string {
  const label = slugForRoute(space?.name || "space");
  return `${label}-${entityToken(space?.id || fallbackId, "s")}`;
}

export function channelRouteKey(channel: SerializedChannel): string {
  const label = slugForRoute(channelTitle(channel) || "channel");
  return `${label}--${channel.id}`;
}

/** Extract the immutable Channel id embedded by current canonical links. */
export function exactChannelIdFromRouteKey(key: string): string | null {
  const decoded = decodePathSegment(key).trim();
  const separator = decoded.indexOf("--");
  if (separator < 0) return null;
  return decoded.slice(separator + 2).trim() || null;
}

export function routeEntityTokenFromKey(key: string, prefix: "s" | "c"): string | null {
  const match = key.match(new RegExp(`(?:^|-)${prefix}([a-z0-9]{8,12})$`));
  return match ? `${prefix}${match[1]}` : null;
}

export function entityToken(id: string, prefix: "s" | "c"): string {
  const compact = id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (!compact) return `${prefix}unknown`;

  try {
    return `${prefix}${BigInt(`0x${compact}`).toString(36).slice(0, 10)}`;
  } catch {
    return `${prefix}${compact.slice(0, 10)}`;
  }
}

export function slugForRoute(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export function normalizeRouteKey(value: string): string {
  return decodePathSegment(value).trim().toLowerCase();
}

export function channelTitle(channel: SerializedChannel): string {
  return (channel.name || channel.id.slice(0, 10)).replace(/^#/, "");
}

export function parseInternalChannelLink(
  href: string,
  currentHref: string
): InternalChannelLink | null {
  let url: URL;
  let currentUrl: URL;
  try {
    currentUrl = new URL(currentHref);
    url = new URL(href, currentUrl);
  } catch {
    return null;
  }

  if (url.origin !== currentUrl.origin) return null;
  const segments = url.pathname.split("/").filter(Boolean).map(decodePathSegment);
  if (segments[0] !== "app") return null;

  const spaceKey = segments[1] || null;
  const channelSegment = segments[2];
  const channelKey =
    channelSegment === "channels" || channelSegment === "c"
      ? segments[3]?.trim()
      : url.searchParams.get("channel")?.trim();
  if (!channelKey) return null;

  return {
    spaceKey,
    channelKey,
    messageId: appLinkMessageIdFromHash(url.hash),
  };
}

export function resolveSpaceRouteKey(spaces: SerializedSpace[], key: string | null): string | null {
  if (!key) return null;
  const normalizedKey = normalizeRouteKey(key);
  const direct = spaces.find((space) => space.id === key || normalizeRouteKey(space.id) === normalizedKey);
  if (direct) return direct.id;

  const exact = spaces.find((space) => normalizeRouteKey(spaceRouteKey(space, space.id)) === normalizedKey);
  if (exact) return exact.id;

  const token = routeEntityTokenFromKey(normalizedKey, "s");
  if (!token) return null;
  return spaces.find((space) => entityToken(space.id, "s") === token)?.id || null;
}

export function resolveChannelRouteKey(
  channels: SerializedChannel[],
  key: string | null,
  spaceId: string | null
): SerializedChannel | null {
  if (!key) return null;
  const scopedChannels = spaceId
    ? channels.filter((channel) => channel.spaceId === spaceId)
    : channels;
  const normalizedKey = normalizeRouteKey(key);
  const direct = scopedChannels.find(
    (channel) => channel.id === key || normalizeRouteKey(channel.id) === normalizedKey
  );
  if (direct) return direct;

  const exactChannelId = exactChannelIdFromRouteKey(key);
  if (exactChannelId) {
    const exactIdMatch = scopedChannels.find((channel) => channel.id === exactChannelId);
    if (exactIdMatch) return exactIdMatch;
  }

  const exact = scopedChannels.find(
    (channel) => normalizeRouteKey(channelRouteKey(channel)) === normalizedKey
  );
  if (exact) return exact;

  const token = routeEntityTokenFromKey(normalizedKey, "c");
  if (!token) return null;
  return scopedChannels.find((channel) => entityToken(channel.id, "c") === token) || null;
}

export function appLinkMessageIdFromHash(hash: string): string | undefined {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith("message:")) return undefined;
  const encoded = raw.slice("message:".length);
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
