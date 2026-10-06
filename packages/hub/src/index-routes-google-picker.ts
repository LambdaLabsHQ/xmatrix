import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import { configuredGooglePicker, confirmGooglePickerFile } from "./connectors/google-picker";
import { readBoundedRequestBody, requireAuth, requireHumanAuth, requestErrorStatus } from "./index-shared";
import { ProviderRequestError } from "./connectors/http";
import type { Env } from "./types";

export function registerGooglePickerRoutes(app: Hono<{ Bindings: Env }>): void {
  const route = HUB_ROUTES.space_app_connection_google_picker(":spaceId").replace("%3AspaceId", ":spaceId");
  app.on(["GET", "POST"], route, async c => {
    try {
      const authenticated = await requireAuth(c.req.raw, c.env);
      if (authenticated.agentRun) return c.json({ error: "Google file selection requires a Human Space admin" }, 403);
      const user = requireHumanAuth(authenticated);
      const spaceId = c.req.param("spaceId")!;
      if (c.req.method === "GET") return c.json(await configuredGooglePicker(c.env, spaceId, user.id), 200,
        { "cache-control": "private, no-store" });
      const bytes = await readBoundedRequestBody(c.req.raw, 1024);
      if (!bytes) return c.json({ error: "Google file selection is too large" }, 413);
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch {
        return c.json({ error: "Invalid Google file selection" }, 400);
      }
      const fileId = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).fileId : undefined;
      if (typeof fileId !== "string") return c.json({ error: "Invalid Google document id" }, 400);
      return c.json(await confirmGooglePickerFile(c.env, spaceId, user.id, fileId), 200,
        { "cache-control": "private, no-store" });
    } catch (error) {
      const status = error instanceof ProviderRequestError ? error.status : requestErrorStatus(error);
      // Never return an external payload or token in an error response.
      return c.json({ error: status === 404 ? "Space not found" : status === 403 ? "Document access was not confirmed" :
        status === 409 ? "Google connection changed or is disconnected; reconnect and choose the file again" :
        status === 503 ? "Google file selection is not configured yet" : "Google file selection could not be confirmed" },
      status as 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502 | 503);
    }
  });
}
