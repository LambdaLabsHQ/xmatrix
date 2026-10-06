import type { SerializedChannel } from "@xmatrix/protocol";

export type ChannelReadStateUpdate = Pick<SerializedChannel, "attention" | "readSequence">;

/**
 * Applies one read-state answer to one Channel. Read-state responses are
 * authoritative for the current viewer: once the cursor passes the last
 * attention row the Hub omits the summary, and assigning `undefined` here is
 * what clears the stale badge. An absent cursor stays absent, because writing
 * a zero would claim "nothing read" over whatever baseline the reader holds.
 */
export function withChannelReadState(
  channel: SerializedChannel,
  update: ChannelReadStateUpdate,
): SerializedChannel {
  return {
    ...channel,
    attention: update.attention,
    ...(update.readSequence !== undefined ? { readSequence: update.readSequence } : {}),
  };
}
