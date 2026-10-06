import { DurableObject } from "cloudflare:workers";

import { RelayPostgresChannelCoordinatorStore } from "./relay-postgres-channel-coordinator";
import { recordChannelReservationCleanup } from "./postgres-coordination-observability";
import type { Env } from "./types";

/** Cloudflare RPC boundary for the bounded PostgreSQL Channel sequence store. */
export class RelayPostgresChannelCoordinator extends DurableObject<Env> {
  private readonly store: RelayPostgresChannelCoordinatorStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RelayPostgresChannelCoordinatorStore(ctx);
  }

  reserve(input: Parameters<RelayPostgresChannelCoordinatorStore["reserve"]>[0]) {
    return this.store.reserve(input);
  }

  confirm(input: Parameters<RelayPostgresChannelCoordinatorStore["confirm"]>[0]) {
    return this.store.confirm(input);
  }

  status(input: Parameters<RelayPostgresChannelCoordinatorStore["status"]>[0]) {
    return this.store.status(input);
  }

  async alarm(): Promise<void> {
    const startedAt = performance.now();
    try {
      const result = await this.store.alarm();
      recordChannelReservationCleanup({ env: this.env, outcome: "ok", ...result });
    } catch (error) {
      recordChannelReservationCleanup({
        env: this.env, outcome: "error", deleted: 0, remaining: 0,
        oldestAgeMs: 0, durationMs: performance.now() - startedAt,
      });
      throw error;
    }
  }
}
