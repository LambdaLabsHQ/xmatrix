import { PostgresPushDeviceRepository } from "@xmatrix/db";
import type { Hono } from "hono";

import { readBoundedRequestBody, requestErrorResponse, requireAuth, requireHumanAuth } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "./postgres-authority-http";
import type { Env } from "./types";

function pushDevices(env: Env): PostgresPushDeviceRepository {
  return new PostgresPushDeviceRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-push-devices", ...POSTGRES_AUTHORITY_TIMEOUTS,
  }));
}

/**
 * A person's own push devices. A client registers the token or subscription
 * its platform gave it after the person allowed notifications, and forgets it
 * on sign-out. Only people register devices; an Agent Run has none.
 */
export function registerIndexRoutesPush(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/push/devices", async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const bytes = await readBoundedRequestBody(c.req.raw, 8192);
      let input: Record<string, unknown> = {};
      try {
        const parsed = bytes ? JSON.parse(new TextDecoder().decode(bytes)) as unknown : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
      } catch { /* answered as an invalid device below */ }
      const device = await pushDevices(c.env).register({
        requestId: crypto.randomUUID(), userId: user.id, platform: input.platform, token: input.token, keys: input.keys,
      });
      return c.json(device, 200, { "cache-control": "private, no-store" });
    } catch (error) { return requestErrorResponse(c, error); }
  });

  app.delete("/api/push/devices/:deviceId", async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      await pushDevices(c.env).unregister({
        requestId: crypto.randomUUID(), userId: user.id, deviceId: c.req.param("deviceId"),
      });
      return c.json({ ok: true }, 200, { "cache-control": "private, no-store" });
    } catch (error) { return requestErrorResponse(c, error); }
  });
}
