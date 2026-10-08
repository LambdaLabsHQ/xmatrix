import type { Hono } from "hono";
import { runtimeRepository } from "./runtime";
import type { Env } from "./types";
import { createProductAgentMentionAuthorityPort } from "./product-agent-mention-authority-adapter";
import { AgentRebornControlError, parseAgentRebornControlBody, requestOwnedInstanceReborn } from "./product-agent-reborn-control";
import { requireAuth, requireHumanAuth, requestErrorResponse } from "./index-shared";
import { domainErrorResponse } from "./error-contract";
import { hasControlCharacter, sha256Hex } from "@xmatrix/protocol";

export function registerAgentRebornRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/channels/:channelId/agent-instances/:instanceId/reborn", async c => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const body = parseAgentRebornControlBody(await c.req.json().catch(() => null));
      const channelId = c.req.param("channelId"), instanceId = c.req.param("instanceId");
      if ([channelId, instanceId].some(id => !id || id.length > 200 || /\s/u.test(id) || hasControlCharacter(id))) {
        throw new AgentRebornControlError("invalid_request", 400, "Invalid Instance identity");
      }
      const { instance } = await runtimeRepository(c.env).getInstance({ requestId: crypto.randomUUID(),
        instanceId, actorUserId: user.id });
      const sourceMessageId = `instance-reborn:${await sha256Hex(JSON.stringify([user.id, channelId, instanceId, body.expectedRunId, body.requestId]))}`;
      const port = createProductAgentMentionAuthorityPort({ env: c.env, actorUserId: user.id, sourceMessageId });
      const queued = await requestOwnedInstanceReborn({ ...body, sourceMessageId, actorUserId: user.id, channelId, instanceId,
        instance: instance as Record<string, unknown>, port });
      return c.json(queued, 202, { "cache-control": "private, no-store" });
    } catch (error) {
      if (error instanceof AgentRebornControlError) return domainErrorResponse(error);
      return requestErrorResponse(c, error);
    }
  });
}
