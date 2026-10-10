import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";

import { readBoundedRequestBody, requestErrorResponse, requireAuth, requireHumanAuth } from "./index-shared";
import { pushConfig, pushDevices } from "./push/notify";
import type { Env } from "./types";

/**
 * A person's own push devices. A client registers the token or subscription
 * its platform gave it after the person allowed notifications, and forgets it
 * on sign-out. Only people register devices; an Agent Run has none.
 */
export function registerIndexRoutesPush(app: Hono<{ Bindings: Env }>): void {
  // What a browser subscribes with. Absent when this Hub does not push to browsers.
  app.get(HUB_ROUTES.push_config, async (c) => {
    try {
      requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const { vapid } = pushConfig(c.env.PUSH_CONFIG);
      return c.json(vapid ? { vapidPublicKey: vapid.publicKey } : {}, 200, { "cache-control": "private, no-store" });
    } catch (error) { return requestErrorResponse(c, error); }
  });

  app.post(HUB_ROUTES.push_devices, async (c) => {
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

  app.delete(HUB_ROUTES.push_device(":deviceId").replace("%3AdeviceId", ":deviceId"), async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      await pushDevices(c.env).unregister({
        requestId: crypto.randomUUID(), userId: user.id, deviceId: c.req.param("deviceId") ?? "",
      });
      return c.json({ ok: true }, 200, { "cache-control": "private, no-store" });
    } catch (error) { return requestErrorResponse(c, error); }
  });
}
