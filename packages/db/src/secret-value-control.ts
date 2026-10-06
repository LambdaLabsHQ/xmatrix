import type { QueryResultRow } from "pg";
import { hmacHex } from "@xmatrix/protocol";
import { ControlError } from "./control-error.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface CiphertextEnvelope {
  algorithm: "AES-GCM";
  /** What the ciphertext is bound to: an owner's catalog row, or a Space secret. */
  keyId: "secret-authority:v1" | "space-secret:v1";
  iv: string;
  ciphertext: string;
}

export class SecretValueControlError extends ControlError {
  override name = "SecretValueControlError";
}

export function secretHmac(material: string, value: string): Promise<string> {
  return hmacHex("SHA-256", material, value);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function key(material: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256",
    encoder.encode(`xmatrix-relay-secret-authority-aes-gcm-v1\0${material}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** `scope` is the owner (secret-authority:v1) or the Space (space-secret:v1). */
function additionalData(keyId: CiphertextEnvelope["keyId"], scope: string, secretRef: string, version: number) {
  return encoder.encode(`${keyId}\0${scope}\0${secretRef}\0${version}`);
}

async function encrypt(material: string, keyId: CiphertextEnvelope["keyId"], scope: string, secretRef: string,
  version: number, value: string): Promise<CiphertextEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv,
    additionalData: additionalData(keyId, scope, secretRef, version), tagLength: 128 },
  await key(material), encoder.encode(value)));
  return { algorithm: "AES-GCM", keyId, iv: base64(iv), ciphertext: base64(ciphertext) };
}

async function decrypt(material: string, envelope: CiphertextEnvelope, scope: string, secretRef: string,
  version: number): Promise<string> {
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(envelope.iv),
      additionalData: additionalData(envelope.keyId, scope, secretRef, version), tagLength: 128 },
    await key(material), fromBase64(envelope.ciphertext));
    return decoder.decode(plaintext);
  } catch {
    throw new SecretValueControlError("secret_authority_corrupt", 409,
      "Secret authority integrity check failed");
  }
}

function envelopeOf(row: QueryResultRow, keyIds: readonly CiphertextEnvelope["keyId"][]): CiphertextEnvelope {
  const envelope = row.encrypted_value_json as unknown as CiphertextEnvelope;
  if (envelope?.algorithm !== "AES-GCM" || !keyIds.includes(envelope.keyId)) {
    throw new SecretValueControlError("secret_authority_corrupt", 409, "Secret authority envelope is invalid");
  }
  return envelope;
}

export async function encryptSecretValue(material: string, ownerUserId: string, secretRef: string,
  version: number, value: string): Promise<CiphertextEnvelope> {
  return encrypt(material, "secret-authority:v1", ownerUserId, secretRef, version, value);
}

export async function decryptSecretValue(material: string, row: QueryResultRow): Promise<string> {
  return decrypt(material, envelopeOf(row, ["secret-authority:v1"]), String(row.owner_user_id),
    String(row.secret_ref), Number(row.authority_version));
}

/** A Space secret's value, bound to its Space, alias and value version. */
export async function encryptSpaceSecretValue(material: string, spaceId: string, secretRef: string,
  version: number, value: string): Promise<CiphertextEnvelope> {
  return encrypt(material, "space-secret:v1", spaceId, secretRef, version, value);
}

/** A row of data.space_secrets. One moved from an owner's catalog keeps its
 * owner binding (created_by_user_id) until its value is next set. */
export async function decryptSpaceSecretValue(material: string, row: QueryResultRow): Promise<string> {
  const envelope = envelopeOf(row, ["space-secret:v1", "secret-authority:v1"]);
  return decrypt(material, envelope, String(envelope.keyId === "space-secret:v1" ? row.space_id : row.created_by_user_id),
    String(row.secret_ref), Number(row.value_version));
}
