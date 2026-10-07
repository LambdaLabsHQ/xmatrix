import type { Hono } from "hono";
import type { Env } from "./types";
import { channelMetadataHistory, configureChannel } from "./spaces";
import { requireAuth, jsonErrors, productCommandId } from "./index-shared";
import { agentRunDelegationDenied } from "./agent-run-channel-delegation";

export function registerChannelMetadataRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/channels/:channelId/metadata-history", (c) => jsonErrors(c, async () => {
    const user = await requireAuth(c.req.raw, c.env);
    const run = user.agentRun;
    const result = await channelMetadataHistory(c.env, {
      channelId: c.req.param("channelId"), principal: run ? { kind: "agent", id: run.agentId } : { kind: "user", id: user.id },
      ...(c.req.query("beforeRevision") !== undefined ? { beforeRevision: Number(c.req.query("beforeRevision")) } : {}),
      ...(c.req.query("revision") !== undefined ? { revision: Number(c.req.query("revision")) } : {}),
      ...(c.req.query("inputId") ? { inputId: c.req.query("inputId") } : {}),
      ...(c.req.query("limit") !== undefined ? { limit: Number(c.req.query("limit")) } : {}),
    });
    return c.json(result, 200, { "cache-control": "private, no-store" });
  }));
  app.post("/api/channels/:channelId/metadata-restore", (c) => jsonErrors(c, async () => {
    const user = await requireAuth(c.req.raw, c.env);
    const channelId = c.req.param("channelId");
    const run = user.agentRun;
    if (run) {
      const denied = await agentRunDelegationDenied(c.env, run, [channelId]);
      if (denied) return denied;
    }
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => !["revision", "expectedRevision"].includes(key)) ||
        !Number.isSafeInteger(body.revision) || body.revision < 0 ||
        !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
      return c.json({ error: "revision and expectedRevision must be non-negative safe integers" }, 400);
    }
    return c.json(await configureChannel(c.env, {
      commandId: productCommandId(c.req.raw, "domain"), channelId,
      actorUserId: run?.ownerUserId ?? user.id, ...(run ? { actorRunId: run.runId } : {}),
      at: new Date().toISOString(), restoreRevision: body.revision, expectedRevision: body.expectedRevision,
    }));
  }));
}
