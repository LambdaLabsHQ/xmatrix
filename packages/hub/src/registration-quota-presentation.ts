import { decodeChannelSnapshot, encodeChannelSnapshot, presenceInstanceId, reduceChannelPresence, withRegistrationQuota } from "@xmatrix/protocol";
import { readRegistrationQuotaState, registrationQuotaKey, type AuthorityDatabase,
  type RegistrationQuotaKey } from "@xmatrix/db";
import type { LlmUsage, SerializedChannel } from "@xmatrix/protocol";

/** Channels passed here have already been authorized and their registration keys are server-derived. */
export async function projectRegistrationQuota(database: AuthorityDatabase,
  channels: readonly Record<string, unknown>[], requestId: string): Promise<void> {
  const keys: RegistrationQuotaKey[] = [];
  for (const channel of channels) {
    for (const presence of decodeChannelSnapshot(channel as unknown as SerializedChannel).presence?.instances.values() ?? []) {
      if (presence.registration) keys.push(presence.registration);
    }
  }
  const unique = [...new Map(keys.map(key => [registrationQuotaKey(key), key])).values()];
  const quotas = new Map<string, LlmUsage>();
  for (let offset = 0; offset < unique.length; offset += 512) {
    for (const [key, quota] of await readRegistrationQuotaState(database, unique.slice(offset, offset + 512), requestId)) quotas.set(key, quota);
  }
  for (const raw of channels) {
    const channel = decodeChannelSnapshot(raw as unknown as SerializedChannel);
    let presence = channel.presence;
    if (!presence) continue;
    for (const instance of presence.instances.values()) {
      const quota = instance.registration ? quotas.get(registrationQuotaKey(instance.registration)) : undefined;
      presence = reduceChannelPresence(presence, { type: "quota", instanceId: instance.id,
        usage: withRegistrationQuota(instance.usage, quota) });
    }
    Object.assign(raw, encodeChannelSnapshot({ ...channel, presence }));
  }
}

export function channelInstanceQuota(channel: SerializedChannel, instanceId: string): LlmUsage | undefined {
  return decodeChannelSnapshot(channel).presence?.instances.get(presenceInstanceId(instanceId))?.usage;
}
