import { ChannelPresenceConflict } from "@xmatrix/protocol";

/** One authoritative repair per Channel and conflicting Instance for this connection's lifetime. */
export function createChannelPresenceRepair(request: (channelId: string) => void) {
  const requested = new Set<string>();
  return (error: unknown) => {
    if (!(error instanceof ChannelPresenceConflict)) return;
    const key = `${error.channelId}\u0000${error.instanceId ?? ""}`;
    if (requested.has(key) || requested.size >= 512) return;
    requested.add(key);
    console.warn("[presence] conflicting_instance_identity", error.channelId);
    request(error.channelId);
  };
}
