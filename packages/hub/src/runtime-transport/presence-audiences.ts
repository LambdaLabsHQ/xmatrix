import { registrationQuotaKey } from "@xmatrix/db";
import type { AgentRegistrationKey, LlmUsage } from "@xmatrix/protocol";

/** One live Instance's viewers as its last Channel read gave them. */
export interface PresenceAudience {
  channelId: string;
  spaceId: string;
  readAt: number;
  /** The Humans other than the owner who may see the Channel. */
  viewers: readonly string[];
  registration?: AgentRegistrationKey;
  /** The newest provider reading the Instance had reported when its quota was last read. */
  quotaCheckedThrough: number;
}

/** A registration's quota reading and when it was read. */
export interface HeldQuota {
  quota: LlmUsage | undefined;
  readAt: number;
}

/** The part of a Durable Object's storage the audiences live in. */
export type PresenceStorage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;

/** A backstop: a catalog change in the Space forgets an audience at once. */
export const PRESENCE_AUDIENCE_TTL_MS = 10 * 60_000;

const AUDIENCE = "presence-audience:";
const QUOTA = "presence-quota:";
const HELD_IN_MEMORY = 1024;

/**
 * What a Runtime cell keeps between a live Instance's status reports, so a
 * report reads no PostgreSQL: who may see the Instance and its registration's
 * last quota reading. The cell hibernates between reports and forgets its
 * memory, so both are kept in the cell's own storage as well; memory only
 * spares the storage read while the cell is awake.
 */
export class PresenceAudiences {
  private readonly audiences = new Map<string, PresenceAudience>();
  private readonly quotas = new Map<string, HeldQuota>();

  constructor(private readonly storage?: PresenceStorage) {}

  async audience(instanceId: string): Promise<PresenceAudience | undefined> {
    const held = this.audiences.get(instanceId) ?? await this.storage?.get<PresenceAudience>(AUDIENCE + instanceId);
    if (held) hold(this.audiences, instanceId, held);
    return held;
  }

  async remember(instanceId: string, audience: PresenceAudience): Promise<void> {
    hold(this.audiences, instanceId, audience);
    await this.storage?.put(AUDIENCE + instanceId, audience);
  }

  async forget(instanceId: string): Promise<void> {
    this.audiences.delete(instanceId);
    await this.storage?.delete(AUDIENCE + instanceId);
  }

  /** Who may see this Space's Channels may have changed. Audiences past their
   *  backstop go too, so an Instance whose leaving was never seen is not kept. */
  async forgetSpace(spaceId: string, now = Date.now()): Promise<void> {
    const stale = (audience: PresenceAudience) =>
      audience.spaceId === spaceId || now - audience.readAt >= PRESENCE_AUDIENCE_TTL_MS;
    for (const [instanceId, audience] of this.audiences) {
      if (stale(audience)) this.audiences.delete(instanceId);
    }
    if (!this.storage) return;
    const stored = await this.storage.list<PresenceAudience>({ prefix: AUDIENCE });
    const keys = [...stored].filter(([, audience]) => stale(audience)).map(([key]) => key);
    if (keys.length) await this.storage.delete(keys);
  }

  async quota(registration: AgentRegistrationKey): Promise<HeldQuota | undefined> {
    const key = registrationQuotaKey(registration);
    const held = this.quotas.get(key) ?? await this.storage?.get<HeldQuota>(QUOTA + key);
    if (held) hold(this.quotas, key, held);
    return held;
  }

  async rememberQuota(registration: AgentRegistrationKey, quota: LlmUsage | undefined, now = Date.now()): Promise<void> {
    const key = registrationQuotaKey(registration);
    const held = { quota, readAt: now };
    hold(this.quotas, key, held);
    await this.storage?.put(QUOTA + key, held);
  }
}

function hold<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  if (map.size >= HELD_IN_MEMORY) map.delete(map.keys().next().value!);
  map.set(key, value);
}
