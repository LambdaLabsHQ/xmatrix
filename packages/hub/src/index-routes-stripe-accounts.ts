import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import { connectorStripeAccountRepository } from "./connectors/credentials";
import { STRIPE_ACCOUNT_ID } from "./connectors/stripe-oauth";
import { requireAuth, requireHumanAuth, jsonErrors } from "./index-shared";
import type { Env } from "./types";

/** Merchant metadata is admin-only; neither endpoint returns a credential. */
export function registerStripeAccountRoutes(app: Hono<{ Bindings: Env }>): void {
  const list = HUB_ROUTES.space_app_connection_stripe_accounts(":spaceId").replace(/%3A/gu, ":");
  const account = HUB_ROUTES.space_app_connection_stripe_account(":spaceId", ":accountId").replace(/%3A/gu, ":");
  app.get(list, c => jsonErrors(c, async () => {
    const auth = await requireAuth(c.req.raw, c.env);
    if (auth.agentRun) return c.json({ error: "A Space admin manages Stripe accounts" }, 403);
    const user = requireHumanAuth(auth);
    const result = await connectorStripeAccountRepository(c.env).list({ spaceId: c.req.param("spaceId")!,
      actorUserId: user.id, after: c.req.query("after") });
    return c.json(result, 200, { "cache-control": "private, no-store" });
  }));
  app.delete(account, c => jsonErrors(c, async () => {
    const auth = await requireAuth(c.req.raw, c.env);
    if (auth.agentRun) return c.json({ error: "A Space admin manages Stripe accounts" }, 403);
    const user = requireHumanAuth(auth), id = c.req.param("accountId")!;
    const body = await c.req.json<{ generation?: unknown }>().catch(() => null);
    if (!STRIPE_ACCOUNT_ID.test(id) || !body || typeof body.generation !== "string") {
      return c.json({ error: "Name the inspected Stripe account generation" }, 400);
    }
    await connectorStripeAccountRepository(c.env).remove({ spaceId: c.req.param("spaceId")!, actorUserId: user.id,
      accountId: id, generation: body.generation });
    return c.json({ ok: true }, 200, { "cache-control": "private, no-store" });
  }));
}
