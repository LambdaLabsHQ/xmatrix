import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import { listXAccounts, removeXAccount } from "./connectors/x-accounts";
import { ProviderRequestError } from "./connectors/http";
import { readBoundedRequestBody, requireAuth, requireHumanAuth, requestErrorStatus } from "./index-shared";
import { checkAppConnection } from "./app-connection-check";
import { upsertAppConnection } from "./apps";
import type { Env } from "./types";

/** Native account management is Human admin only; a grant or token never leaves the Hub. */
export function registerXAccountRoutes(app: Hono<{ Bindings: Env }>): void {
  const routes = [HUB_ROUTES.space_app_connection_x_accounts(":spaceId"),
    HUB_ROUTES.space_app_connection_x_account(":spaceId", ":accountId")].map(route => route.replace(/%3A/gu, ":"));
  app.on(["GET", "DELETE"], routes, async c => {
    try {
      const authenticated = await requireAuth(c.req.raw, c.env);
      if (authenticated.agentRun) return c.json({ error: "A Space admin manages X accounts" }, 403);
      const user = requireHumanAuth(authenticated), spaceId = c.req.param("spaceId")!;
      if (c.req.method === "GET") return c.json({ accounts: await listXAccounts(c.env, { spaceId, actorUserId: user.id }) },
        200, { "cache-control": "private, no-store" });
      const bytes = await readBoundedRequestBody(c.req.raw, 512);
      if (!bytes) return c.json({ error: "Request is too large" }, 413);
      let body: Record<string, unknown> | undefined;
      try { body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; } catch { /* invalid below */ }
      const id = c.req.param("accountId");
      if (!id || !/^[1-9][0-9]{0,19}$/u.test(id) || typeof body?.generation !== "string") {
        return c.json({ error: "Name the X account and current authorization generation" }, 400);
      }
      const accounts = await removeXAccount(c.env, { spaceId, actorUserId: user.id, id, generation: body.generation });
      if (accounts.length) await checkAppConnection(c.env, { spaceId, providerId: "x", userId: user.id,
        commandId: `x-account-remove-check:${crypto.randomUUID()}` });
      else await upsertAppConnection(c.env, { commandId: `x-account-empty:${crypto.randomUUID()}`, spaceId,
        providerId: "x", actorUserId: user.id, body: { status: "disconnected" } });
      return c.json({ accounts }, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      const status = error instanceof ProviderRequestError ? error.status : requestErrorStatus(error);
      return c.json({ error: error instanceof ProviderRequestError ? error.message : "X accounts could not be managed" },
        status as 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503);
    }
  });
}
