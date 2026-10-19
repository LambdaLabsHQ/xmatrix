import type { Hono } from "hono";
import { requireAuth, requireHumanAuth, jsonErrors, readBoundedRequestBody, productCommandId } from "./index-shared";
import { deleteChannel } from "./spaces";
import type { Env } from "./types";

export function registerChannelDeletionRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/spaces/:spaceId/channels/:channelId/deletion", c => jsonErrors(c, async () => {
    const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const bytes = await readBoundedRequestBody(c.req.raw, 4096);
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())); }
    catch { return c.json({ error: "Invalid deletion confirmation" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirmation !== "DELETE" ||
        body.acknowledge !== true || typeof body.name !== "string" || !body.name || body.name.length > 300)
      return c.json({ error: "Confirm the current Channel name, DELETE and the consequences" }, 400);
    const result = await deleteChannel(c.env, { commandId: productCommandId(c.req.raw, "domain"),
      spaceId: c.req.param("spaceId"), channelId: c.req.param("channelId"), actorUserId: user.id,
      name: body.name, at: new Date().toISOString() });
    return c.json(result, 202, { "cache-control": "private, no-store" });
  }));
}
