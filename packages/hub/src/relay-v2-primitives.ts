import { utf8ByteLength } from "@xmatrix/protocol";

export { utf8ByteLength };

export function isBoundedTrimmedUtf8String(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && utf8ByteLength(value) <= maxBytes
    && !/\p{Cc}/u.test(value);
}

export { canonicalJsonStringify as canonicalJson } from "@xmatrix/protocol";

export function base64UrlEncodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Unpadded base64url of UTF-8 text or of raw bytes. */
export function base64UrlEncodeValue(value: string | ArrayBuffer | Uint8Array): string {
  return base64UrlEncodeBytes(typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
}

/** Raw base64 decoding; callers retain their format, size, and canonicality checks. */
export function base64DecodeBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function base64UrlDecodeBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("invalid base64url");
  const padding = (4 - (value.length % 4)) % 4;
  try {
    return base64DecodeBytes(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(padding));
  } catch {
    throw new TypeError("invalid base64url");
  }
}

export { concatenateBytes } from "@xmatrix/protocol";

export { sha256BytesSync as sha256Sync } from "@xmatrix/protocol";
