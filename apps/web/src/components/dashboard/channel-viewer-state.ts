import type { ChannelSnapshot } from "@xmatrix/protocol";

export type ChannelViewerStateAuthority = "authoritative" | "partial";

export type ChannelViewerState = Pick<
  ChannelSnapshot,
  "attention" | "readSequence"
>;

/**
 * A complete Channel catalog is scoped to the authenticated viewer, so an
 * omitted field authoritatively clears stale state. Realtime `channel_updated`
 * messages are partial shared snapshots and must preserve the viewer's local
 * projection instead.
 */
export function mergeChannelViewerState(
  prior: ChannelSnapshot | undefined,
  incoming: ChannelSnapshot,
  authority: ChannelViewerStateAuthority,
): ChannelViewerState {
  if (authority === "authoritative") {
    return {
      attention: incoming.attention,
      readSequence: incoming.readSequence,
    };
  }
  return {
    attention: incoming.attention ?? prior?.attention,
    readSequence: incoming.readSequence ?? prior?.readSequence,
  };
}
