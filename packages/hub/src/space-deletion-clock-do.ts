import { DurableObject } from "cloudflare:workers";
import { PostgresSpaceControlRepository } from "@xmatrix/db";
import type { Env } from "./types";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { serialQueue } from "./serial-queue";
import { SpaceDeletionClock } from "./space-deletion-clock";
import { purgeDeletedSpace } from "./space-deletion-purge";

export class RelaySpaceDeletionClock extends DurableObject<Env> {
  private readonly clock: SpaceDeletionClock;
  private readonly serial = serialQueue();
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.clock = new SpaceDeletionClock(state.storage, async spaceId => {
      if (!env.RELAY_PAYLOAD_BUCKET || !env.RELAY_POSTGRES_SHARD_ID) throw new Error("Space purge unavailable");
      const session = createPostgresAuthorityDatabase(env, { applicationName: "xmatrix-space-purge",
        statementTimeoutMs: 10_000, transactionTimeoutMs: 20_000, lockTimeoutMs: 2_000 }).openSession();
      try {
        const spaces = new PostgresSpaceControlRepository(session, env.RELAY_POSTGRES_SHARD_ID);
        const result = await purgeDeletedSpace({ spaces, bucket: env.RELAY_PAYLOAD_BUCKET, spaceId });
        if (result.rows || result.objects) console.info("Space purge progressed", { spaceId, ...result });
        return result.nextAt;
      } finally { await session.close(); }
    });
  }
  async arm(spaceId: string, dueAt: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => this.clock.arm(spaceId, dueAt));
  }
  async alarm(): Promise<void> { await this.serial(() => this.clock.alarm()); }
}
