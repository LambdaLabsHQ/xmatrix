import { lowercaseHex } from "@xmatrix/protocol";

/** A conversation id that is the same every time for the same purpose, so asking again reuses it. */
export async function deterministicConversationId(...parts: string[]): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n"))));
  const hex = lowercaseHex(hash.slice(0, 16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
