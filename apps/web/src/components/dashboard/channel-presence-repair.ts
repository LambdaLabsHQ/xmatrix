import { ChannelPresenceConflict } from "@xmatrix/protocol";

/** Retry only on incoming reports, at most three times in a five-minute window. */
export function createChannelPresenceRepair(request: (channelId: string) => void) {
  const requested = new Map<string, { attempts: number; nextAt: number; expiresAt: number }>();
  return (error: unknown) => {
    if (!(error instanceof ChannelPresenceConflict)) return;
    const now = Date.now();
    for (const [key, held] of requested) if (held.expiresAt <= now) requested.delete(key);
    const key = `${error.channelId}\u0000${error.instanceId ?? ""}`;
    const held = requested.get(key);
    if (held && (held.attempts >= 3 || held.nextAt > now)) return;
    if (!held && requested.size >= 512) requested.delete(requested.keys().next().value!);
    requested.set(key, { attempts: (held?.attempts ?? 0) + 1, nextAt: now + 1_000,
      expiresAt: held?.expiresAt ?? now + 300_000 });
    console.warn("[presence] conflicting_instance_identity", error.channelId);
    request(error.channelId);
  };
}
