/**
 * Uploaded Human avatars.
 *
 * An avatar is unlike a message attachment in the one way that decides its
 * storage: it is shown to everyone who can see the person, on every message
 * they ever sent, in lists that render hundreds at a time. That rules out the
 * private-R2 path, whose read requires a capability signed for one
 * `(channelId, messageId, attachmentId)` — an `<img src>` cannot present one,
 * and there is no channel to scope a face to anyway.
 *
 * So avatar objects are content-addressed and served from an unauthenticated
 * route. Anyone holding the URL can fetch the image; the key is a SHA-256 of
 * the bytes, so the URL is unguessable but not secret. That is the same trade
 * Slack and every comparable product makes, and it is a decision rather than
 * an oversight: a face that needed an authenticated fetch could not be an
 * `<img>` at all.
 */

/** Formats a client may upload. Anything else is refused before any I/O. */
export const HUMAN_AVATAR_MIME_TYPES = ["image/webp", "image/png", "image/jpeg"] as const;

export type HumanAvatarMimeType = (typeof HUMAN_AVATAR_MIME_TYPES)[number];

/**
 * Square edge the client renders to before uploading. Large enough for a
 * retina profile header, small enough that the encoded result is a few tens of
 * kilobytes — which is what keeps the byte ceiling below generous.
 */
export const HUMAN_AVATAR_EDGE_PX = 512;

/**
 * Hard ceiling on a stored avatar. A 512px square re-encoded as WebP lands far
 * under this; the headroom exists for PNG sources with awkward content, not to
 * invite large uploads.
 */
export const HUMAN_AVATAR_MAX_BYTES = 1024 * 1024;

const EXTENSIONS: Record<HumanAvatarMimeType, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};

const MIME_BY_EXTENSION: Record<string, HumanAvatarMimeType> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
};

export function humanAvatarMimeType(value: string | null | undefined): HumanAvatarMimeType | null {
  if (!value) return null;
  // A browser may append parameters; the type alone decides.
  const base = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (HUMAN_AVATAR_MIME_TYPES as readonly string[]).includes(base)
    ? (base as HumanAvatarMimeType)
    : null;
}

export function humanAvatarExtension(mimeType: HumanAvatarMimeType): string {
  return EXTENSIONS[mimeType];
}

/**
 * The Content-Type a stored object is served with, derived from its key rather
 * than from anything a client said at upload time or a sniffer guesses later.
 */
export function humanAvatarMimeTypeForObjectKey(key: string): HumanAvatarMimeType | null {
  const extension = key.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? null;
}

/**
 * Content-addressed, and namespaced by owner so one person's uploads can be
 * listed or purged without touching anyone else's. The hash is the whole
 * identity of the object: re-uploading identical bytes is idempotent, and a
 * stored object never changes, which is what makes `immutable` caching honest.
 */
export function humanAvatarObjectKey(
  userId: string,
  contentHash: string,
  mimeType: HumanAvatarMimeType,
): string {
  return `avatars/${userId}/${contentHash}.${humanAvatarExtension(mimeType)}`;
}

/* No `.` in the owner segment. With it, `..` is a legal segment and
   `../<hash>.webp` validates — which is exactly the traversal this is here to
   refuse. Account ids are alphanumeric with `-`/`_`, so nothing is lost. */
const OBJECT_PATH = /^[A-Za-z0-9_~-]{1,128}\/[0-9a-f]{64}\.(?:webp|png|jpg)$/u;

/**
 * Validates the `<userId>/<hash>.<ext>` tail of a read URL before it reaches
 * R2. Rejecting here is what stops a traversal or a wildcard from becoming a
 * bucket read, rather than trusting the router's own path parsing.
 */
export function isHumanAvatarObjectPath(value: string): boolean {
  return OBJECT_PATH.test(value);
}

/**
 * Leading bytes each accepted format must begin with.
 *
 * Checked because a Content-Type header is a client's claim, not evidence. It
 * does not make the payload safe — a Worker has no image decoder to re-encode
 * with — but combined with a fixed response Content-Type and `nosniff` it
 * closes the path where an upload is later served as an active document.
 */
export function humanAvatarBytesMatchMimeType(
  bytes: Uint8Array,
  mimeType: HumanAvatarMimeType,
): boolean {
  if (mimeType === "image/png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (mimeType === "image/jpeg") {
    return startsWith(bytes, [0xff, 0xd8, 0xff]);
  }
  // RIFF....WEBP — the size field between the two markers is not fixed.
  return (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    startsWith(bytes.subarray(8, 12), [0x57, 0x45, 0x42, 0x50])
  );
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}
