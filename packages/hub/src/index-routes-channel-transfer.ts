import type { Hono } from "hono";
import type { Env } from "./types";
import { privateRouteResponse } from "./private-route-response";
import { requireAuth, requireHumanAuth } from "./index-shared";
import { acknowledgeChannelTransfer, createChannelTransfer, listChannelTransfers } from "./spaces";
import { daemonStopTargets, issueDaemonStopsForArchivedChannelTree } from "./product-agent-intervention-authority-adapter";

const NO_STORE = { "cache-control": "private, no-store" };

export function registerChannelTransferRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/channels/:channelId/transfer-proposals", (c) => privateRouteResponse(c, async () => {
      const user = await requireAuth(c.req.raw, c.env);
      const channelId = c.req.param("channelId");
      const body = await c.req.json<Record<string, unknown>>();
      if (user.agentRun && channelId !== user.agentRun.channelId) return c.json({ error: "Birth Channel required" }, 403);
      if (body.parentChannelId !== undefined) return c.json({
        error: "A conversation moves to another Space on its own; it has no parent there.",
        code: "channel_hierarchy_retired",
      }, 410);
      return Response.json(await createChannelTransfer(c.env, {
        proposalId: typeof body.proposalId === "string" ? body.proposalId : crypto.randomUUID(),
        channelId, targetSpaceId: String(body.spaceId ?? ""),
        principal: user.agentRun ? { kind: "agent", id: user.agentRun.agentId } : { kind: "user", id: user.id },
      }), { headers: NO_STORE });
  }));
  app.get("/api/spaces/:spaceId/channel-transfers", (c) => privateRouteResponse(c, async () => {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const spaceId = c.req.param("spaceId");
      const channelId = c.req.query("channelId");
      return Response.json(await listChannelTransfers(c.env, { spaceId, ...(channelId ? { channelId } : {}),
        principal: { kind: "user", id: user.id } }), { headers: NO_STORE });
  }));
  app.post("/api/spaces/:spaceId/channel-transfers/:proposalId/ack", (c) => privateRouteResponse(c, async () => {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const sourceSpaceId = c.req.param("spaceId");
      const body = await c.req.json<Record<string, unknown>>();
      const proposalId = c.req.param("proposalId");
      const result = await acknowledgeChannelTransfer(c.env, { sourceSpaceId, proposalId,
        role: body.role as "outbound" | "inbound", principal: { kind: "user", id: user.id } });
      const { stopTargets: rawStopTargets, ...payload } = result;
      const stopTargets = daemonStopTargets(rawStopTargets);
      if (stopTargets.length > 0) {
        // The move already stopped these Runs; the daemon kills are best-effort.
        c.executionCtx.waitUntil(issueDaemonStopsForArchivedChannelTree({
          env: c.env, actorUserId: user.id, rootChannelId: `transfer:${proposalId}`,
          reason: "The Channel moved to another Space", targets: stopTargets,
        }));
      }
      return Response.json(payload, { headers: { "cache-control": "private, no-store" } });
  }));
}
