import { armEarlierSpaceAlarm, requireSpaceClockSpace, type SpaceClockStorage } from "./space-clock-storage";

/** Per-Space clock only. PostgreSQL owns retention, leases and deletion evidence. */
export class SummonDecisionClock {
  private armVersion = 0;
  constructor(private readonly storage: SpaceClockStorage, private readonly maintain: (spaceId: string) => Promise<number | null>, private readonly now = Date.now) {}

  async arm(spaceId: string): Promise<void> {
    if (!spaceId || spaceId.length > 300) throw new Error("Invalid Space");
    const existing = await this.storage.get<string>("spaceId");
    if (existing && existing !== spaceId) throw new Error("Decision clock Space mismatch");
    this.armVersion++;
    await armEarlierSpaceAlarm(this.storage, spaceId, () => this.now() + 60_000);
  }

  async alarm(): Promise<void> {
    const spaceId = await requireSpaceClockSpace(this.storage, "Decision clock has no Space");
    const version = this.armVersion;
    // Persist recovery before any database/R2 work, including process interruption.
    await this.storage.setAlarm(this.now() + 300_000);
    const next = await this.maintain(spaceId);
    // An in-flight summon already persisted its earlier wake; do not erase it.
    if (version !== this.armVersion) return;
    if (next === null) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(Math.max(this.now() + 300_000, next));
  }
}
