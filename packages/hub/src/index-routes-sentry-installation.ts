import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import type { Env } from "./types";
import { completeSentryInstallation } from "./connectors/sentry-install-connect";
import { readBoundedRequestBody, requireAuth, requireHumanAuth, requestErrorStatus } from "./index-shared";
import { ProviderRequestError } from "./connectors/http";

export function registerSentryInstallationRoutes(app: Hono<{ Bindings: Env }>): void {
  const path = HUB_ROUTES.space_app_connection_sentry_install(":spaceId").replace("%3AspaceId", ":spaceId");
  app.post(path, async c => {
    c.header("cache-control", "private, no-store");
    try {
      const auth = await requireAuth(c.req.raw, c.env);
      if (auth.agentRun) return c.json({ error: "Sentry installation requires a Human Space admin" }, 403);
      const user = requireHumanAuth(auth);
      const bytes = await readBoundedRequestBody(c.req.raw, 12 * 1024);
      if (!bytes) return c.json({ error: "Sentry installation request is too large" }, 413);
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { return c.json({ error: "Invalid Sentry installation request" }, 400); }
      const body = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown> : {};
      if (body.confirmed !== true || typeof body.code !== "string" || !/^[\x21-\x7e]{1,8192}$/u.test(body.code) ||
          typeof body.installationId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(body.installationId) ||
          typeof body.organization !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(body.organization) ||
          Object.keys(body).some(key => !["confirmed", "code", "installationId", "organization"].includes(key))) {
        return c.json({ error: "Confirm a valid Sentry organization and Space" }, 400);
      }
      return c.json(await completeSentryInstallation(c.env, { spaceId: c.req.param("spaceId")!, userId: user.id,
        code: body.code, installationId: body.installationId, organization: body.organization, confirmed: true }));
    } catch (error) {
      const status = error instanceof ProviderRequestError ? error.status : requestErrorStatus(error);
      const safeStatus = [400, 401, 403, 404, 409, 413, 500, 502, 503].includes(status) ? status : 502;
      return c.json({ error: safeStatus === 404 ? "Space not found" : safeStatus === 409 ?
        "Sentry connection changed, expired or was uninstalled; start a fresh installation" : safeStatus === 503 ?
          "Sentry installation is unavailable" : "Sentry installation could not be confirmed; start again" },
      safeStatus as 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502 | 503);
    }
  });
}
