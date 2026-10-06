import type { FeishuAppIdentity, TelegramAppIdentity } from "@xmatrix/db";
import type { Hono } from "hono";
import type { Env } from "./types";
import { readBoundedRequestBody, requireAuth, requireHumanAuth, requestErrorStatus } from "./index-shared";
import { connectorCredentialRepository, connectorFeishuRoomRepository } from "./connectors/credentials";

type Native = { app: FeishuAppIdentity | TelegramAppIdentity };
/** Both group providers retain Human admin authority, private challenges and bounded exact unlink. */
export function registerGroupLinkRoutes<N extends Native>(app: Hono<{ Bindings: Env }>, config: {
  provider: "feishu" | "telegram"; label: string; path: (spaceId: string) => string;
  native: (env: Env) => Promise<N | undefined>; rooms: (env: Env) => ReturnType<typeof connectorFeishuRoomRepository>;
  source: (chatSpace: string) => string | Promise<string>; selection: (payload: Record<string, unknown>) => string;
  getChat: (env: Env, native: N, chatSpace: string) => Promise<{ botUsername?: string }>;
}): void {
  const path = config.path(":spaceId").replace("%3AspaceId", ":spaceId");
  app.on(["GET", "POST", "DELETE"], path, async c => {
    try {
      const auth = await requireAuth(c.req.raw, c.env);
      if (auth.agentRun) return c.json({ error: `Linking ${config.label} requires a Human Space admin` }, 403);
      const user = requireHumanAuth(auth), spaceId = c.req.param("spaceId")!;
      await connectorCredentialRepository(c.env).readGenerated({ requestId: crypto.randomUUID(), spaceId,
        providerId: config.provider, actorUserId: user.id, generated: [] });
      const native = await config.native(c.env);
      if (!native) return c.json({ error: `${config.label} company app is not configured` }, 503);
      const rooms = config.rooms(c.env);
      if (c.req.method === "GET") {
        const bindings = await rooms.list({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
        return c.json({ bindings: await Promise.all(bindings.map(async binding => ({ chatSpace: binding.chatSpace,
          sourceRef: await config.source(binding.chatSpace) }))) }, 200, { "cache-control": "private, no-store" });
      }
      const bytes = await readBoundedRequestBody(c.req.raw, 1024);
      if (!bytes) return c.json({ error: `${config.label} selection is too large` }, 413);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return c.json({ error: `Invalid ${config.label} selection` }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: `Choose a ${config.label} group` }, 400);
      const payload = body as Record<string, unknown>;
      const chatSpace = config.selection(payload);
      if (c.req.method === "DELETE") {
        await rooms.unlink({ requestId: crypto.randomUUID(), app: native.app, spaceId, actorUserId: user.id, chatSpace });
        return c.json({ ok: true }, 200, { "cache-control": "private, no-store" });
      }
      const bot = await config.getChat(c.env, native, chatSpace);
      const attempt = await rooms.begin({ requestId: crypto.randomUUID(), app: native.app, spaceId, actorUserId: user.id, chatSpace });
      return c.json({ ...attempt, ...bot }, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      const status = typeof (error as { status?: number }).status === "number" ? (error as { status: number }).status : requestErrorStatus(error);
      return c.json({ error: status === 404 ? `Space or ${config.label} app membership not found` : status === 403 ? `${config.label} group access was not confirmed` :
        status === 409 ? `${config.label} authorization changed or this group is already connected; start again` :
        status === 503 ? `${config.label} app is not configured or available` : `${config.label} group could not be confirmed` },
        status as 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502 | 503);
    }
  });
}
