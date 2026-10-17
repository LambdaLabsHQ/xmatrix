import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import { listCloudflareLogins, removeCloudflareLogin } from "./connectors/cloudflare-logins";
import { ProviderRequestError } from "./connectors/http";
import { requireAuth, requireHumanAuth, requestErrorStatus } from "./index-shared";
import { checkAppConnection } from "./app-connection-check";
import { upsertAppConnection } from "./apps";
import type { Env } from "./types";

const LOGIN_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

/** A Space admin lists the Cloudflare connection's logins or removes one; a token never leaves the Hub. */
export function registerCloudflareLoginRoutes(app: Hono<{ Bindings: Env }>): void {
  const routes = [HUB_ROUTES.space_app_connection_cloudflare_logins(":spaceId"),
    HUB_ROUTES.space_app_connection_cloudflare_login(":spaceId", ":loginId")].map(route => route.replace(/%3A/gu, ":"));
  app.on(["GET", "DELETE"], routes, async c => {
    try {
      const authenticated = await requireAuth(c.req.raw, c.env);
      if (authenticated.agentRun) return c.json({ error: "A Space admin manages Cloudflare logins" }, 403);
      const user = requireHumanAuth(authenticated), spaceId = c.req.param("spaceId")!;
      if (c.req.method === "GET") {
        return c.json({ logins: await listCloudflareLogins(c.env, { spaceId, actorUserId: user.id }) },
          200, { "cache-control": "private, no-store" });
      }
      const id = c.req.param("loginId");
      if (!id || !LOGIN_ID.test(id)) return c.json({ error: "Name the Cloudflare login" }, 400);
      const logins = await removeCloudflareLogin(c.env, { spaceId, actorUserId: user.id, id });
      if (logins.length) await checkAppConnection(c.env, { spaceId, providerId: "cloudflare", userId: user.id,
        commandId: `cloudflare-login-remove-check:${crypto.randomUUID()}` });
      else await upsertAppConnection(c.env, { commandId: `cloudflare-login-empty:${crypto.randomUUID()}`, spaceId,
        providerId: "cloudflare", actorUserId: user.id, body: { status: "disconnected" } });
      return c.json({ logins }, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      const status = error instanceof ProviderRequestError ? error.status : requestErrorStatus(error);
      return c.json({ error: error instanceof ProviderRequestError ? error.message : status === 403 || status === 404
        ? "Only a Space owner or admin manages Cloudflare logins" : "Cloudflare logins could not be managed" },
      status as 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503);
    }
  });
}
