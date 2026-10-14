import type { Hono } from "hono";
import { plainRecord } from "@xmatrix/protocol";
import { requireAuth, requireHumanAuth, readBoundedRequestBody, requestErrorStatus } from "./index-shared";
import { getAppConnectorProvider } from "./app-connectors";
import { publishCommandStatus } from "./connectors/command-support";
import { getChannel } from "./spaces";
import { connectorActionRequestRepository } from "./connectors/credentials";
import { connectorProvider } from "./connectors/registry";
import { connectorActionCatalog } from "./connectors/action-catalog";
import { announceActionRequests, runConnectorAction } from "./connectors/connector-commands";
import type { Env } from "./types";

/** Decisions accept only a request reference; provider input always comes from the frozen encrypted request. */
export function registerConnectorApprovalRoutes(app: Hono<{ Bindings: Env }>) {
  const context = async (request: Request, env: Env, channelId: string) => {
    const authenticated = await requireAuth(request, env);
    if (authenticated.agentRun) throw Object.assign(new Error("Only a Human answers action approvals"), { status: 403 });
    const user = requireHumanAuth(authenticated);
    const { channel } = await getChannel(env, { channelId, principal: { kind: "user", id: user.id } });
    const spaceId = plainRecord(channel)?.spaceId;
    if (typeof spaceId !== "string") throw Object.assign(new Error("Channel not found"), { status: 404 });
    return { channelId, spaceId, actorUserId: user.id };
  };
  const failure = (error: unknown) => Response.json({ error: error instanceof Error ? error.message : "Action approval failed" },
    { status: typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : requestErrorStatus(error),
      headers: { "cache-control": "private, no-store" } });

  app.get("/api/channels/:channelId/connector-action-requests", async c => {
    try {
      const scope = await context(c.req.raw, c.env, c.req.param("channelId"));
      const requests = await connectorActionRequestRepository(c.env).pending(scope);
      return c.json({ requests }, 200, { "cache-control": "private, no-store" });
    } catch (error) { return failure(error); }
  });
  app.post("/api/channels/:channelId/connector-action-requests/:requestId", async c => {
    try {
      const scope = await context(c.req.raw, c.env, c.req.param("channelId"));
      const bytes = await readBoundedRequestBody(c.req.raw, 1_024);
      let decision: Record<string, unknown> | undefined;
      try { decision = bytes ? plainRecord(JSON.parse(new TextDecoder().decode(bytes))) ?? undefined : undefined; } catch { /* invalid */ }
      if (!decision || !["allow", "disallow"].includes(String(decision.decision)) || Object.keys(decision).length !== 1) {
        return c.json({ error: "Choose allow or disallow for this request" }, 400);
      }
      const repository = connectorActionRequestRepository(c.env);
      const result = await repository.decide({ ...scope, requestId: c.req.param("requestId"), allow: decision.decision === "allow" });
      // Answered either way, it no longer waits: every admin's dock drops it.
      await announceActionRequests(c.env, scope.spaceId, scope.channelId);
      if (!result.claimed || !result.payload) {
        const manifest = getAppConnectorProvider(result.request.providerId);
        if (manifest && result.request.status === "denied") {
          await publishCommandStatus(manifest, { env: c.env, channelId: scope.channelId,
            actorUserId: scope.actorUserId, messageId: `${result.request.requestId}:denied`, body: "" },
          [`${manifest.name} ${result.request.actionId}: denied; request ${result.request.requestId} was disallowed; nothing was sent.`]);
        }
        return c.json({ request: result.request }, 200, { "cache-control": "private, no-store" });
      }
      const { request, payload } = result;
      const provider = connectorProvider(request.providerId);
      const action = provider ? connectorActionCatalog(provider.id, provider.actions).get(request.actionId)?.executor : undefined;
      let status: "completed" | "blocked" | "failed" = "blocked";
      let receipt = "Action is no longer available";
      try {
        if (action) {
          receipt = await runConnectorAction(request.providerId, { env: c.env, channelId: scope.channelId,
            actorUserId: request.requestedBy, messageId: `${payload.messageId}:approved`,
            commandMessageId: payload.messageId, body: "",
            senderKind: payload.senderKind, senderId: payload.senderId }, request.actionId, action, payload.statement,
          { requestId: request.requestId, prepared: payload.prepared });
          status = /: completed;/u.test(receipt) ? "completed" : /: blocked;/u.test(receipt) ? "blocked" : "failed";
        }
      } catch { status = "failed"; receipt = "Action did not finish; do not retry an uncertain provider write"; }
      await repository.settle(request.requestId, status);
      return c.json({ request: { ...request, status }, receipt }, 200, { "cache-control": "private, no-store" });
    } catch (error) { return failure(error); }
  });
}
