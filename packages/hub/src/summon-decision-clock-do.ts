import { DurableObject } from "cloudflare:workers";
import { PostgresContentRepository } from "@xmatrix/db";
import type { Env } from "./types";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { serialQueue } from "./serial-queue";
import { cleanupSummonDecisions } from "./summon-decision-cleanup";
import { SummonDecisionClock } from "./summon-decision-clock";

export class RelaySummonDecisionClock extends DurableObject<Env> {
  private readonly clock: SummonDecisionClock;
  private readonly serial = serialQueue();
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.clock = new SummonDecisionClock(state.storage, async spaceId => {
      if (!env.RELAY_PAYLOAD_BUCKET || !env.RELAY_POSTGRES_SHARD_ID) throw new Error("Decision cleanup unavailable");
      const session = createPostgresAuthorityDatabase(env, { applicationName: "xmatrix-decision-cleanup",
        statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000 }).openSession();
      try {
        const content = new PostgresContentRepository(session, env.RELAY_POSTGRES_SHARD_ID);
        const result = await cleanupSummonDecisions({ content, bucket: env.RELAY_PAYLOAD_BUCKET, spaceId });
        console.info("Decision cleanup completed", result);
        return await content.nextDecisionMaintenance({ requestId: crypto.randomUUID(), spaceId });
      } finally { await session.close(); }
    });
  }
  async arm(spaceId: string): Promise<void> { await this.ctx.blockConcurrencyWhile(() => this.clock.arm(spaceId)); }
  async alarm(): Promise<void> { await this.serial(() => this.clock.alarm()); }
}
