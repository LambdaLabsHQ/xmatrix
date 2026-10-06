import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import type { Env } from "./types";
import { readBoundedRequestBody, requireAuth, requireHumanAuth, requestErrorStatus } from "./index-shared";
import { connectorCredentialRepository, connectorGoogleChatRoomRepository } from "./connectors/credentials";
import { googleChatNativeApp } from "./connectors/googlechat-native";
import { googleChatSource } from "./connectors/googlechat-events";

/** Human-only confirmation initiation; no Agent tool can mint or read the challenge. */
export function registerGoogleChatRoutes(app: Hono<{ Bindings: Env }>): void {
  const path = HUB_ROUTES.space_app_connection_googlechat_link(":spaceId").replace("%3AspaceId", ":spaceId");
  app.on(["GET", "POST"], path, async c => {
    try {
      const auth = await requireAuth(c.req.raw, c.env);
      if (auth.agentRun) return c.json({ error: "Linking Google Chat requires a Human Space admin" }, 403);
      const user = requireHumanAuth(auth), spaceId = c.req.param("spaceId")!;
      // A live admin check precedes every shared-SA provider request or room identity read.
      await connectorCredentialRepository(c.env).readGenerated({ requestId: crypto.randomUUID(),
        spaceId, providerId: "googlechat", actorUserId: user.id, generated: [] });
      const native = googleChatNativeApp(c.env);
      if (!native) return c.json({ error: "Google Chat app is not configured" }, 503);
      const rooms = connectorGoogleChatRoomRepository(c.env);
      if (c.req.method === "GET") {
        const binding = await rooms.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
        return c.json({ binding: binding ? { chatSpace: binding.chatSpace,
          sourceRef: await googleChatSource(binding.chatSpace) } : null }, 200, { "cache-control": "private, no-store" });
      }
      const bytes = await readBoundedRequestBody(c.req.raw, 1024);
      if (!bytes) return c.json({ error: "Google Chat selection is too large" }, 413);
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch {
        return c.json({ error: "Invalid Google Chat selection" }, 400);
      }
      const chatSpace = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).chatSpace : undefined;
      if (typeof chatSpace !== "string" || Object.keys(payload as object).some(key => key !== "chatSpace")) {
        return c.json({ error: "Name a Google Chat space" }, 400);
      }
      await native.client.getSpace(chatSpace);
      const attempt = await rooms.begin({ requestId: crypto.randomUUID(), app: native.app,
        spaceId, actorUserId: user.id, chatSpace });
      return c.json(attempt, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      const status = typeof (error as { status?: number }).status === "number"
        ? (error as { status: number }).status : requestErrorStatus(error);
      return c.json({ error: status === 404 ? "Space or Google Chat app membership not found" :
        status === 403 ? "Google Chat space access was not confirmed" :
        status === 409 ? "Google Chat connection changed or this room is already connected; start again" :
        status === 503 ? "Google Chat app is not configured or available" : "Google Chat space could not be confirmed" },
      status as 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502 | 503);
    }
  });
}
