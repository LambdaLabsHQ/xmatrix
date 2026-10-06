import { DurableObject } from "cloudflare:workers";

import {
  admissionStripe,
  BackgroundAdmission,
  backgroundAdmissionBudget,
  type BackgroundAdmissionDecision,
  type BackgroundLane,
} from "./postgres-background-admission";
import type { Env } from "./types";

/**
 * One stripe of one PostgreSQL shard's background permits. Permits live in
 * memory: losing this object only forgets leases that lapse within 30 s.
 */
export class RelayPostgresBackgroundAdmission extends DurableObject<Env> {
  private readonly admission: BackgroundAdmission;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    const budget = backgroundAdmissionBudget(env);
    this.admission = new BackgroundAdmission(budget.stripeLimit, budget.stripeMaintenanceLimit);
  }

  async acquire(holder: string, lane: BackgroundLane): Promise<BackgroundAdmissionDecision> {
    return this.admission.acquire(holder, lane);
  }

  async release(holder: string): Promise<void> {
    this.admission.release(holder);
  }
}

/** The stripe a Channel asks on its shard, or undefined where the binding is absent (tests). */
export function backgroundAdmissionFor(env: Pick<Env, "RELAY_POSTGRES_BACKGROUND_ADMISSION" |
  "POSTGRES_BACKGROUND_PASS_LIMIT" | "POSTGRES_BACKGROUND_ADMISSION_STRIPES">, shardId: string, channelId: string) {
  const namespace = env.RELAY_POSTGRES_BACKGROUND_ADMISSION;
  if (!namespace) return undefined;
  const stripe = admissionStripe(channelId, backgroundAdmissionBudget(env).stripes);
  return namespace.get(namespace.idFromName(`postgres-background-admission:${shardId}:${stripe}`)) as unknown as {
    acquire(holder: string, lane: BackgroundLane): Promise<BackgroundAdmissionDecision>;
    release(holder: string): Promise<void>;
  };
}
