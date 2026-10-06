import type { Hono } from "hono";
import type { Env } from "./types";
import { evaluateJevRequest } from "./jev-evaluation-handler";
import { readBoundedRequestBody, requireAuth, requireLiveAgentRun, requestErrorStatus } from "./index-shared";

export function registerIndexRoutesJev(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/ai/jev/evaluate", async (c) => {
    try {
      return await evaluateJevRequest(c.req.raw, c.env, async () => {
        const user = await requireAuth(c.req.raw, c.env);
        return user.agentRun ? (await requireLiveAgentRun(c.env, user)).ownerUserId : user.id;
      }, readBoundedRequestBody);
    } catch (error) {
      return c.json({ error: "jev_access_denied" }, requestErrorStatus(error), { "cache-control": "private, no-store" });
    }
  });
}
