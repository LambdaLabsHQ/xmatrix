import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import { listMailboxes, updateMailbox } from "./connectors/gmail-mailboxes";
import { ProviderRequestError } from "./connectors/http";
import { readBoundedRequestBody, requireAuth, requireHumanAuth, requestErrorStatus } from "./index-shared";
import type { Env } from "./types";

/** A Space admin lists the Gmail connection's mailboxes, reassigns one (`owner`) or removes it (`owner: null`). */
export function registerGmailMailboxRoutes(app: Hono<{ Bindings: Env }>): void {
  const route = HUB_ROUTES.space_app_connection_gmail_mailboxes(":spaceId").replace("%3AspaceId", ":spaceId");
  app.on(["GET", "PUT"], route, async c => {
    try {
      const authenticated = await requireAuth(c.req.raw, c.env);
      if (authenticated.agentRun) return c.json({ error: "Gmail mailboxes are managed by a Space admin" }, 403);
      const user = requireHumanAuth(authenticated);
      const spaceId = c.req.param("spaceId")!;
      if (c.req.method === "GET") {
        return c.json({ mailboxes: await listMailboxes(c.env, { spaceId, actorUserId: user.id }) }, 200,
          { "cache-control": "private, no-store" });
      }
      const bytes = await readBoundedRequestBody(c.req.raw, 1024);
      if (!bytes) return c.json({ error: "Request is too large" }, 413);
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; } catch {
        return c.json({ error: "Invalid mailbox request" }, 400);
      }
      if (typeof body.address !== "string" || (body.owner !== null && typeof body.owner !== "string")) {
        return c.json({ error: "Invalid mailbox request" }, 400);
      }
      return c.json({ mailboxes: await updateMailbox(c.env, { spaceId, actorUserId: user.id,
        address: body.address, owner: body.owner as string | null }) }, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      const status = error instanceof ProviderRequestError ? error.status : requestErrorStatus(error);
      return c.json({ error: error instanceof ProviderRequestError ? error.message : status === 403 || status === 404
        ? "Only a Space owner or admin manages Gmail mailboxes" : "Gmail mailboxes could not be updated" },
      status as 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503);
    }
  });
}
