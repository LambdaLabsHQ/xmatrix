import type { Hono } from "hono";
import type { Env } from "./types";
import { evaluateJevRequest } from "./jev-evaluation-handler";
import { readBoundedRequestBody, requireAuth, requireLiveAgentRun, requestErrorStatus } from "./index-shared";
import { spaceBilling } from "@xmatrix/billing";
import { PostgresBillingRepository } from "@xmatrix/db";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS, postgresAuthorityShardId } from "./postgres-authority-http";
import { jevEvaluationScope } from "./jev-evaluation-access";

/** The Space's plan as its billing authority states it, read for the requesting member. */
export function readJevSpacePlan(env: Env): (spaceId: string, actorUserId: string) => Promise<"free" | "pro"> {
  return async (spaceId, actorUserId) => {
    const repository = new PostgresBillingRepository(createPostgresAuthorityDatabase(env, {
      applicationName: "xmatrix-hub-jev-admission", ...POSTGRES_AUTHORITY_TIMEOUTS,
    }), postgresAuthorityShardId(env, "billing"));
    const status = await repository.readSpaceBilling({ requestId: crypto.randomUUID(), spaceId, actorUserId });
    return status.billing.plan === "pro" ? "pro" : "free";
  };
}

export function registerIndexRoutesJev(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/ai/jev/evaluate", async (c) => {
    try {
      return await evaluateJevRequest(c.req.raw, c.env, async () => {
        const user = await requireAuth(c.req.raw, c.env);
        return jevEvaluationScope(user, c.req.header("x-xmatrix-space-id") ?? null,
          () => requireLiveAgentRun(c.env, user), readJevSpacePlan(c.env), spaceBilling.metered);
      }, readBoundedRequestBody);
    } catch (error) {
      return c.json({ error: "jev_access_denied" }, requestErrorStatus(error), { "cache-control": "private, no-store" });
    }
  });
}
