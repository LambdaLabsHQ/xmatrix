import { lowercaseHex } from "@xmatrix/protocol";
import { sha256 } from "./vendor/norn/runtime/sha256";

function formatUuidV5(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-5${hex32.slice(13, 16)}-8${hex32.slice(17, 20)}-${hex32.slice(20, 32)}`;
}

/** A conversation id that is the same every time for the same purpose, so asking again reuses it. */
export async function deterministicConversationId(...parts: string[]): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n"))));
  return formatUuidV5(lowercaseHex(hash.slice(0, 16)));
}

/** Synchronous twin of `deterministicConversationId`, identical bit-for-bit, for pure transaction steps. */
export function deterministicConversationIdSync(...parts: string[]): string {
  return formatUuidV5(sha256(parts.join("\n")).slice(0, 32));
}
