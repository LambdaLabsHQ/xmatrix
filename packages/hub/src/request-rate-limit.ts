import { sha256Hex } from "@xmatrix/protocol";
import type { Hono } from "hono";
import type { Env } from "./types";

/** A Workers Rate Limiting binding: a per-key counter over a fixed window. */
export interface RequestRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * What a request is counted against.
 *
 * - `credential`: a request carrying a bearer credential, counted per credential.
 *   Keying on the credential itself, not on an id read from it, means nobody
 *   can spend someone else's allowance without holding their token.
 * - `anonymous`: everything else, counted per client IP.
 * - `human_connect`: a Human socket's sign-in, counted per verified user, so a
 *   client redialling in a loop is refused before it costs a presence fanout.
 */
export type RateLimitClass = "credential" | "anonymous" | "human_connect";

/** Seconds a refused caller is told to wait: the limiters count per minute. */
export const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

/**
 * Whether one more request for `key` is admitted.
 *
 * Over the limit is always logged. It is refused only when
 * `RATE_LIMIT_ENFORCED` is "true", so limits can be measured against real
 * traffic before they turn anyone away. A missing binding admits everything.
 */
export async function admitRequest(
  env: Pick<Env, "RATE_LIMIT_CREDENTIAL" | "RATE_LIMIT_ANONYMOUS" | "RATE_LIMIT_HUMAN_CONNECT" | "RATE_LIMIT_ENFORCED">,
  rateClass: RateLimitClass,
  key: string,
  detail: Record<string, string> = {},
): Promise<boolean> {
  const limiter = {
    credential: env.RATE_LIMIT_CREDENTIAL,
    anonymous: env.RATE_LIMIT_ANONYMOUS,
    human_connect: env.RATE_LIMIT_HUMAN_CONNECT,
  }[rateClass];
  if (!limiter) return true;
  const { success } = await limiter.limit({ key: `${rateClass}:${key}` });
  if (success) return true;
  const enforced = env.RATE_LIMIT_ENFORCED === "true";
  console.warn("xMatrix rate limit exceeded", { rateClass, enforced, ...detail });
  return !enforced;
}

export function rateLimitedResponse(): Response {
  return Response.json(
    { error: "Too many requests. Try again shortly.", code: "rate_limited", retryable: true },
    { status: 429, headers: { "Retry-After": String(RATE_LIMIT_RETRY_AFTER_SECONDS) } },
  );
}

/** One-way, so the limiter's key space never holds a usable credential. */
async function credentialKey(credential: string): Promise<string> {
  return (await sha256Hex(credential)).slice(0, 32);
}

function bearerCredential(request: Request): string | undefined {
  const header = request.headers.get("Authorization")?.trim();
  if (!header?.toLowerCase().startsWith("bearer ")) return undefined;
  return header.slice(7).trim() || undefined;
}

/**
 * Who an anonymous request is counted as. A subrequest from one of our own
 * Workers arrives from a Cloudflare address shared by every user it serves,
 * so it is not counted per IP. Cloudflare sets `CF-Worker` to the calling
 * Worker's zone, and a Worker cannot set it for a zone that is not its own.
 */
function anonymousKey(request: Request): string | undefined {
  const worker = request.headers.get("CF-Worker");
  const host = new URL(request.url).hostname;
  if (worker && (host === worker || host.endsWith(`.${worker}`))) return undefined;
  return request.headers.get("CF-Connecting-IP") ?? undefined;
}

/**
 * Refuse a caller over its allowance before the request reaches any route,
 * and so before it can cost a database round trip.
 */
export function registerRequestRateLimit(app: Hono<{ Bindings: Env }>): void {
  app.use("*", async (context, next) => {
    const request = context.req.raw;
    const path = new URL(request.url).pathname;
    const credential = bearerCredential(request);
    const admitted = credential
      ? await admitRequest(context.env, "credential", await credentialKey(credential), { path })
      : await admitAnonymous(context.env, request, path);
    return admitted ? next() : rateLimitedResponse();
  });
}

async function admitAnonymous(env: Env, request: Request, path: string): Promise<boolean> {
  const key = anonymousKey(request);
  return key ? admitRequest(env, "anonymous", key, { path }) : true;
}
