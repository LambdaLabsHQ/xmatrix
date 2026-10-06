import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import type { Env } from "./types";
import { readBoundedRequestBody, requireAuth, requireHumanAuth, requestErrorStatus } from "./index-shared";
import { connectorCredentialRepository, connectorTeamsRoomRepository } from "./connectors/credentials";
import { teamsNativeApp } from "./connectors/teams-native";
import { teamsSource } from "./connectors/teams-events";

/** Human admin initiation; no Agent tool can mint, list or consume these private capabilities. */
export function registerTeamsRoutes(app: Hono<{ Bindings: Env }>): void {
  const path = HUB_ROUTES.space_app_connection_teams_link(":spaceId").replace("%3AspaceId", ":spaceId");
  app.on(["GET", "POST", "DELETE"], path, async c => {
    c.header("cache-control", "private, no-store");
    c.header("referrer-policy", "no-referrer");
    try {
      const auth = await requireAuth(c.req.raw, c.env);
      if (auth.agentRun) return c.json({ error: "Linking Teams requires a Human Space admin" }, 403);
      const user = requireHumanAuth(auth), spaceId = c.req.param("spaceId")!;
      await connectorCredentialRepository(c.env).readGenerated({ requestId: crypto.randomUUID(),
        spaceId, providerId: "teams", actorUserId: user.id, generated: [] });
      const native = teamsNativeApp(c.env);
      if (!native) return c.json({ error: "Teams company app is not configured" }, 503);
      const rooms = connectorTeamsRoomRepository(c.env);
      if (c.req.method === "GET") {
        const binding = await rooms.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
        const pending = await rooms.pending({ requestId: crypto.randomUUID(), app: native.app, spaceId });
        return c.json({ pending, binding: binding ? { chatSpace: binding.chatSpace, sourceRef: teamsSource(binding.chatSpace),
          conversationType: binding.teamsReference?.conversationType } : null });
      }
      const bytes = await readBoundedRequestBody(c.req.raw, 1024);
      if (!bytes) return c.json({ error: "Teams selection is too large" }, 413);
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { return c.json({ error: "Invalid Teams selection" }, 400); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return c.json({ error: "Invalid Teams selection" }, 400);
      const selected = payload as Record<string, unknown>;
      if (c.req.method === "DELETE") {
        if (typeof selected.chatSpace !== "string" || !/^room-[a-f0-9]{64}$/u.test(selected.chatSpace) || Object.keys(selected).length !== 1) {
          return c.json({ error: "Select the connected Teams conversation" }, 400);
        }
        await rooms.unlink({ requestId: crypto.randomUUID(), app: native.app, spaceId, actorUserId: user.id, chatSpace: selected.chatSpace });
        return c.json({ ok: true });
      }
      if (Object.keys(selected).length !== 0) return c.json({ error: "Teams chooses the conversation during native confirmation" }, 400);
      const attempt = await rooms.begin({ requestId: crypto.randomUUID(), app: native.app,
        spaceId, actorUserId: user.id, chatSpace: "pending" });
      return c.json({ nonce: attempt.nonce, expiresAt: attempt.expiresAt });
    } catch (error) {
      const status = typeof (error as { status?: number }).status === "number"
        ? (error as { status: number }).status : requestErrorStatus(error);
      return c.json({ error: status === 404 ? "Space or Teams connection not found" :
        status === 409 ? "Teams authorization changed; start again" :
        status === 503 ? "Teams app is not configured or available" : "Teams connection could not be confirmed" },
      status as 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502 | 503);
    }
  });
}
