import { PostgresBillingRepository } from "@xmatrix/db";
import type { Context } from "hono";
import { readBoundedRequestBody, requestErrorResponse } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS, postgresAuthorityShardId } from "./postgres-authority-http";
import type { Env } from "./types";
import { StoreBillingError } from "./store-billing-errors";

/** One JSON object from a store billing request, bounded. */
export async function storeRequestBody(request: Request, limit: number, invalid: () => StoreBillingError): Promise<Record<string, unknown>> {
  const bytes = await readBoundedRequestBody(request, limit);
  if (!bytes) throw invalid();
  try {
    const text = new TextDecoder().decode(bytes).trim();
    const parsed = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw invalid(); }
}

/** Uncached authority for a store's billing routes. */
export function storeBillingDatabase(env: Env, store: string) {
  const db = createPostgresAuthorityDatabase(env, { applicationName: `xmatrix-hub-${store}-billing`, ...POSTGRES_AUTHORITY_TIMEOUTS });
  return { db, billing: new PostgresBillingRepository(db, postgresAuthorityShardId(env, `${store}-billing`)) };
}

export function storeErrorResponse(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof StoreBillingError) return c.json({ code: error.code, error: error.message },
    error.retryable || error.code.endsWith("_billing_unavailable") ? 503 : 400);
  return requestErrorResponse(c, error);
}
