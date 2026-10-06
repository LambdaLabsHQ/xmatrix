import { armEarlierSpaceAlarm, requireSpaceClockSpace, type SpaceClockStorage } from "./space-clock-storage";

const RECOVERY_MS = 300_000;

/** Per-Space clock only. PostgreSQL owns the deletion, its restore window and every purge step. */
export class SpaceDeletionClock {
  constructor(private readonly storage: SpaceClockStorage, private readonly purge: (spaceId: string) => Promise<number | null>, private readonly now = Date.now) {}

  private armVersion = 0;
  private armedDueAt = Number.POSITIVE_INFINITY;

  /** Wakes no later than `dueAt`; an earlier wake just learns the current due time from PostgreSQL. */
  async arm(spaceId: string, dueAt: number): Promise<void> {
    if (!spaceId || spaceId.length > 300 || !Number.isFinite(dueAt)) throw new Error("Invalid Space deletion");
    const existing = await this.storage.get<string>("spaceId");
    if (existing && existing !== spaceId) throw new Error("Space deletion clock Space mismatch");
    this.armVersion++;
    this.armedDueAt = Math.min(this.armedDueAt, dueAt);
    await armEarlierSpaceAlarm(this.storage, spaceId, () => Math.max(this.now(), dueAt));
  }

  async alarm(): Promise<void> {
    const spaceId = await requireSpaceClockSpace(this.storage, "Space deletion clock has no Space");
    const version = this.armVersion;
    this.armedDueAt = Number.POSITIVE_INFINITY;
    // Persist recovery before any database or R2 work, including process interruption.
    await this.storage.setAlarm(this.now() + RECOVERY_MS);
    const next = await this.purge(spaceId);
    // A deletion scheduled again during this purge read keeps its own wake.
    const due = version === this.armVersion ? next : Math.min(next ?? Number.POSITIVE_INFINITY, this.armedDueAt);
    if (due === null || due === Number.POSITIVE_INFINITY) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(Math.max(this.now(), due));
  }
}

/** Arms the purge clock of one scheduled Space deletion. */
export async function armSpaceDeletionClock(
  env: { RELAY_SPACE_DELETION_CLOCK?: DurableObjectNamespace },
  spaceId: string,
  purgeAfter: string,
): Promise<void> {
  const namespace = env.RELAY_SPACE_DELETION_CLOCK;
  if (!namespace) throw new Error("Space deletion clock is unavailable");
  const stub = namespace.get(namespace.idFromName(spaceId)) as unknown as {
    arm(spaceId: string, dueAt: number): Promise<void>;
  };
  await stub.arm(spaceId, Date.parse(purgeAfter));
}
