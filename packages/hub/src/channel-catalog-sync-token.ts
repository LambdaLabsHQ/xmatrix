import { base64DecodeBytes } from "./relay-v2-primitives";
const CATALOG_SYNC_PROTOCOL_VERSION = 1 as const;
const MAX_SYNC_TOKEN_LENGTH = 8_192;
const MAX_SYNC_SPACES = 96;

export type CatalogRevisionVector = Map<string, number>;

function encodeOpaqueJson(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 4_096) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 4_096));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeOpaqueJson(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const bytes = base64DecodeBytes(padded);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function encodeChannelCatalogSyncToken(revisions: CatalogRevisionVector): string | undefined {
  if (revisions.size > MAX_SYNC_SPACES) return undefined;
  const spaces = [...revisions].sort(([left], [right]) => left.localeCompare(right));
  const token = encodeOpaqueJson(JSON.stringify({ v: CATALOG_SYNC_PROTOCOL_VERSION, spaces }));
  return token.length <= MAX_SYNC_TOKEN_LENGTH ? token : undefined;
}

export function decodeChannelCatalogSyncToken(token: string | undefined): CatalogRevisionVector | undefined {
  if (!token || token.length > MAX_SYNC_TOKEN_LENGTH) return undefined;
  const decoded = decodeOpaqueJson(token);
  if (!decoded) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { v?: unknown; spaces?: unknown };
  if (record.v !== CATALOG_SYNC_PROTOCOL_VERSION || !Array.isArray(record.spaces) ||
      record.spaces.length > MAX_SYNC_SPACES) return undefined;
  const revisions: CatalogRevisionVector = new Map();
  let previousId = "";
  for (const entry of record.spaces) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [spaceId, revision] = entry;
    if (typeof spaceId !== "string" || !spaceId || spaceId.length > 180 ||
        spaceId <= previousId || !Number.isSafeInteger(revision) || Number(revision) < 0) {
      return undefined;
    }
    revisions.set(spaceId, Number(revision));
    previousId = spaceId;
  }
  return revisions;
}

export function planChannelCatalogDelta(
  previous: CatalogRevisionVector,
  current: CatalogRevisionVector,
): { replacedSpaceIds: string[]; removedSpaceIds: string[] } {
  const replacedSpaceIds = [...current.keys()].filter((spaceId) =>
    previous.get(spaceId) !== current.get(spaceId)
  );
  const removedSpaceIds = [...previous.keys()].filter((spaceId) => !current.has(spaceId));
  return { replacedSpaceIds, removedSpaceIds };
}
