/**
 * Exact request allowances. Each counted key (one bearer credential, one
 * client IP, one Human's socket sign-ins, ...) has its own Durable Object
 * holding a token bucket in memory, so every request for that key is decided
 * by the one object that saw all of them.
 *
 * This replaces the Workers Rate Limiting binding, whose counts are cached per
 * machine: on 2026-11-19 one Agent Run read 2,795 Channels at up to ~400
 * requests/s on a single 1,200-per-minute credential, the binding refused none
 * of them, and the shared PostgreSQL pool queued 886 clients until every
 * user's query timed out. A probe of 5,000 requests in 24 s on one credential
 * was likewise refused zero times.
 */

/** Which allowance a request is counted against; see request-rate-limit.ts. */
export type AllowanceClass = "credential" | "anonymous" | "human_connect" | "jev_evaluate"
  | "search_rerank";

/** A sustained rate per minute, and how many requests may arrive at once. */
export interface AllowanceRule {
  perMinute: number;
  burst: number;
}

/**
 * Credential: a client may keep 20 requests/s; a burst of 240 covers a page
 * load or an Agent's ordinary command run (the busiest single address in a
 * week of production sent at most ~430 per minute, through the shared Web
 * proxy). Each request costs one to three PostgreSQL sessions, so one
 * credential's ceiling stays well below what the pool serves.
 */
export const ALLOWANCE_RULES: Readonly<Record<AllowanceClass, AllowanceRule>> = {
  credential: { perMinute: 1200, burst: 240 },
  anonymous: { perMinute: 600, burst: 120 },
  human_connect: { perMinute: 30, burst: 30 },
  jev_evaluate: { perMinute: 10, burst: 10 },
  search_rerank: { perMinute: 30, burst: 30 },
};

/** A token bucket: `take` answers 0 when admitted, else the seconds until a request fits. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(private readonly rule: AllowanceRule, now: number) {
    this.tokens = rule.burst;
    this.updatedAt = now;
  }

  take(now: number): number {
    const perMs = this.rule.perMinute / 60_000;
    this.tokens = Math.min(this.rule.burst, this.tokens + Math.max(0, now - this.updatedAt) * perMs);
    this.updatedAt = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    // A refused request takes nothing, so being refused does not extend the wait.
    return Math.max(1, Math.ceil((1 - this.tokens) / perMs / 1000));
  }
}

export interface RequestAllowanceStub {
  take(rateClass: AllowanceClass): Promise<number>;
}

export interface RequestAllowanceNamespace {
  idFromName(name: string): unknown;
  get(id: never): unknown;
}

/** The longest an allowance answer is awaited before the request is admitted unanswered. */
export const ALLOWANCE_ANSWER_TIMEOUT_MS = 1_000;

/**
 * Seconds until `key` may send another `rateClass` request; 0 when admitted.
 *
 * An unreachable or slow allowance object admits the request: the allowance
 * protects the Hub, it must not become a way for the Hub to refuse everyone.
 * An object that says it is overloaded is the one key flooding it, so that
 * request is refused.
 */
export async function takeAllowance(
  namespace: RequestAllowanceNamespace,
  rateClass: AllowanceClass,
  key: string,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stub = namespace.get(namespace.idFromName(`${rateClass}:${key}`) as never) as RequestAllowanceStub;
    const unanswered = new Promise<number>((resolve) => {
      timer = setTimeout(() => resolve(0), ALLOWANCE_ANSWER_TIMEOUT_MS);
    });
    return await Promise.race([stub.take(rateClass), unanswered]);
  } catch (error) {
    if ((error as { overloaded?: unknown } | null)?.overloaded === true) {
      return Math.ceil(60 / ALLOWANCE_RULES[rateClass].perMinute) || 1;
    }
    console.warn("xMatrix request allowance unavailable", { rateClass, error: String(error) });
    return 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
