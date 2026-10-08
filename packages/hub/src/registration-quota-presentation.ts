import { withRegistrationQuota } from "@xmatrix/protocol";
import { readRegistrationQuotaState, registrationQuotaKey, type AuthorityDatabase,
  type RegistrationQuotaKey } from "@xmatrix/db";
import type { LlmUsage, SerializedChannel } from "@xmatrix/protocol";

/** Channels passed here have already been authorized and their registration keys are server-derived. */
export async function projectRegistrationQuota(database: AuthorityDatabase,
  channels: readonly Record<string, unknown>[], requestId: string): Promise<void> {
  const keys: RegistrationQuotaKey[] = [];
  for (const channel of channels) {
    for (const presence of Object.values((channel as unknown as SerializedChannel).memberPresence ?? {})) {
      if (presence.kind === "agent" && presence.registration) keys.push(presence.registration);
    }
  }
  const unique = [...new Map(keys.map(key => [registrationQuotaKey(key), key])).values()];
  const quotas = new Map<string, LlmUsage>();
  for (let offset = 0; offset < unique.length; offset += 512) {
    for (const [key, quota] of await readRegistrationQuotaState(database, unique.slice(offset, offset + 512), requestId)) quotas.set(key, quota);
  }
  for (const raw of channels) {
    const channel = raw as unknown as SerializedChannel;
    for (const presence of Object.values(channel.memberPresence ?? {})) {
      if (presence.kind !== "agent") continue;
      const quota = presence.registration ? quotas.get(registrationQuotaKey(presence.registration)) : undefined;
      presence.usage = withRegistrationQuota(presence.usage, quota);
      presence.instances = presence.instances?.map(instance => ({ ...instance,
        usage: withRegistrationQuota(instance.usage, quota) }));
    }
  }
}

export function channelInstanceQuota(channel: SerializedChannel, instanceId: string): LlmUsage | undefined {
  return Object.values(channel.memberPresence ?? {}).find(presence =>
    presence.kind === "agent" && presence.instances?.some(instance => instance.id === instanceId))?.usage;
}
