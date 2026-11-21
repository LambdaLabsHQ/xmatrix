import { DurableObject } from "cloudflare:workers";

import { ALLOWANCE_RULES, TokenBucket, type AllowanceClass } from "./request-allowance";
import type { Env } from "./types";

/**
 * One counted key's allowance (request-allowance.ts). The bucket lives in
 * memory: losing this object only hands its key a fresh burst.
 */
export class RelayRequestAllowance extends DurableObject<Env> {
  private bucket: TokenBucket | undefined;

  async take(rateClass: AllowanceClass): Promise<number> {
    const now = Date.now();
    this.bucket ??= new TokenBucket(ALLOWANCE_RULES[rateClass], now);
    return this.bucket.take(now);
  }
}
