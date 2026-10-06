import * as encoding from "lib0/encoding";
import type { Decoder } from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import type { Doc } from "yjs";

/** Outer page-session framing; the caller supplies the standard Yjs sync payload. */
export function encodePageSync(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

export function encodePageAwareness(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** An empty Yjs response is just the outer tag and must never be sent. */
export function readPageSyncReply(decoder: Decoder, doc: Doc, origin: unknown): { kind: number; reply?: Uint8Array } {
  let kind = 0;
  const reply = encodePageSync(encoder => { kind = syncProtocol.readSyncMessage(decoder, encoder, doc, origin); });
  return { kind, ...(reply.length > 1 ? { reply } : {}) };
}
