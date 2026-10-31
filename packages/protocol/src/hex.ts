import { ResumableSha256 } from "./resumable-sha256.js";

/** Bytes as lowercase hex, two digits per byte. */
export function lowercaseHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

const UTF8_ENCODER = new TextEncoder();

/** The UTF-8 byte length of a string, the size limit a message or row uses. */
export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

/** The SHA-256 of a string's UTF-8 bytes (or of raw bytes), as lowercase hex. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value);
  return lowercaseHex(await crypto.subtle.digest("SHA-256", bytes));
}

/** The HMAC of a UTF-8 message under a UTF-8 secret, as raw bytes. */
export async function hmacBytes(hash: "SHA-1" | "SHA-256", secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", UTF8_ENCODER.encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, UTF8_ENCODER.encode(message)));
}

/** The HMAC of a UTF-8 message under a UTF-8 secret, as lowercase hex. */
export async function hmacHex(hash: "SHA-1" | "SHA-256", secret: string, message: string): Promise<string> {
  return lowercaseHex(await hmacBytes(hash, secret, message));
}

/** Whether two strings are equal, in time independent of where they differ; lengths are not secret. */
export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function sha256BytesSync(input: Uint8Array): Uint8Array {
  const digest = new ResumableSha256();
  digest.update(input);
  return digest.digestBytes();
}
