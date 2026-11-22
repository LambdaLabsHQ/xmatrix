import type { Hono } from "hono";
import type { Env } from "./types";
import { connectorMailSnapshotLeaseRepository } from "./connectors/credentials";
import { MAIL_SNAPSHOT_ROUTE, serveMailSnapshot } from "./connectors/mail-snapshot-link";

/** Composio fetches an approved Gmail draft snapshot here; the unguessable, short-lived token is the only credential. */
export function registerMailSnapshotRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get(`${MAIL_SNAPSHOT_ROUTE}:token`, (c) => {
    const leases = c.env.RELAY_POSTGRES?.connectionString && c.env.RELAY_POSTGRES_SHARD_ID?.trim()
      ? connectorMailSnapshotLeaseRepository(c.env) : undefined;
    return serveMailSnapshot(c.env.ATTACHMENT_BUCKET, c.req.param("token"), Date.now, leases);
  });
}
