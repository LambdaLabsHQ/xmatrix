import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "@xmatrix/protocol";
import { ProviderRequestError } from "./http";

const rejected = () => new ProviderRequestError(401, "Native callback authentication failed");
/** Provider callbacks share the AES envelope, but each caller supplies its fixed registered identity. */
export function decryptCallbackEnvelope(aesKey: string, receiver: string, ciphertext: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(ciphertext) || ciphertext.length > 45_000) throw rejected();
  const encrypted = Buffer.from(ciphertext, "base64"), key = Buffer.from(aesKey + "=", "base64");
  if (encrypted.toString("base64") !== ciphertext || encrypted.length < 32 || encrypted.length % 16 !== 0) throw rejected();
  try {
    const cipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16)); cipher.setAutoPadding(false);
    const padded = Buffer.concat([cipher.update(encrypted), cipher.final()]);
    // DingTalk and WeCom use 32-byte PKCS#7, rather than the cipher's automatic 16-byte padding.
    const padding = padded[padded.length - 1]!;
    if (padding < 1 || padding > 32 || padded.length % 32 !== 0 ||
        padded.subarray(padded.length - padding).some(byte => byte !== padding)) throw rejected();
    const bytes = padded.subarray(0, padded.length - padding);
    if (bytes.length < 20) throw rejected();
    const length = bytes.readUInt32BE(16);
    if (length > 32 * 1024 || length + 20 >= bytes.length) throw rejected();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    if (!timingSafeEqual(decoder.decode(bytes.subarray(20 + length)), receiver)) throw rejected();
    return decoder.decode(bytes.subarray(20, 20 + length));
  } catch { throw rejected(); }
}

export function encryptCallbackEnvelope(aesKey: string, receiver: string, message: string): string {
  const content = Buffer.from(message, "utf8"), size = Buffer.alloc(4);
  if (content.length > 32 * 1024) throw rejected();
  size.writeUInt32BE(content.length);
  const plain = Buffer.concat([randomBytes(16), size, content, Buffer.from(receiver, "utf8")]);
  const pad = 32 - plain.length % 32, key = Buffer.from(aesKey + "=", "base64");
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]).toString("base64");
}
