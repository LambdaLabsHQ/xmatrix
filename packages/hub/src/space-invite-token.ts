import { base64UrlDecodeBytes, base64UrlEncodeBytes } from "./relay-v2-primitives";

const SPACE_ID_MAX_BYTES = 180;
const INVITE_ENTROPY_PATTERN = /^[a-f0-9]{64}$/u;

/** PostgreSQL resolves opaque invite hashes through its authoritative directory;
 * scoped-control invites must still carry their exact Space route. */
export function spaceInviteAuthorityScope(token: string):
  { kind: "space"; spaceId: string } | { kind: "global" } | null {
  const spaceId = spaceIdFromInviteToken(token);
  if (spaceId) return { kind: "space", spaceId };
  return INVITE_ENTROPY_PATTERN.test(token) ? { kind: "global" } : null;
}

/** Resolve the Space routing coordinate before consulting the Space authority. */
export function spaceIdFromInviteToken(token: string): string | null {
  const [version, encodedSpace, entropy, extra] = token.split(".");
  if (version !== "v1" || !encodedSpace || !entropy || extra !== undefined ||
      !INVITE_ENTROPY_PATTERN.test(entropy)) return null;
  try {
    const bytes = base64UrlDecodeBytes(encodedSpace);
    if (bytes.byteLength === 0 || bytes.byteLength > SPACE_ID_MAX_BYTES ||
        base64UrlEncodeBytes(bytes) !== encodedSpace) return null;
    const spaceId = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return spaceId.trim() === spaceId && spaceId ? spaceId : null;
  } catch {
    return null;
  }
}
