import type { Context } from "hono";
import type { Env } from "./types";

/** Answers about one person's view of a Space are never cached. */
export const NO_STORE = { "cache-control": "no-store" } as const;

/** A request's JSON object body; anything else reads as no fields. */
export async function jsonBody(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown>> {
  return c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
}
