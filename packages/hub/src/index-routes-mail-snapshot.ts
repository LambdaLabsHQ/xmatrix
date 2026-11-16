import type { Hono } from "hono";
import type { Env } from "./types";
import { MAIL_SNAPSHOT_ROUTE, serveMailSnapshot } from "./connectors/mail-snapshot-link";

/** Composio fetches an approved Gmail draft snapshot here; the unguessable, short-lived token is the only credential. */
export function registerMailSnapshotRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get(`${MAIL_SNAPSHOT_ROUTE}:token`, (c) => serveMailSnapshot(c.env.ATTACHMENT_BUCKET, c.req.param("token")));
}
