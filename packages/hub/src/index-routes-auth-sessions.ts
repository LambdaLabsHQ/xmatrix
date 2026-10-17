import type { Hono } from "hono";
import { HUB_ROUTES } from "@xmatrix/protocol";
import {
  accessTokenSessionId,
  listSignedInSessions,
  revokeOtherSignedInSessions,
  revokeSignedInSession,
} from "./auth-sessions";
import { readBearerToken } from "./auth";
import { failureResponse } from "./error-contract";
import { requestFailure, requireAuth, requireHumanAuth } from "./index-shared";
import { logAuthMetric } from "./auth-observability";
import type { Env } from "./types";

/** A signed-in person's own sessions: list them, end one, or end all the others. Agents cannot. */
export function registerAuthSessionRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get(HUB_ROUTES.me_sessions, async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const current = accessTokenSessionId(readBearerToken(c.req.header("authorization")) ?? undefined);
      return c.json(await listSignedInSessions(c.env, user.id, current), 200, { "cache-control": "no-store" });
    } catch (error) {
      return failureResponse(requestFailure(error));
    }
  });

  app.post(HUB_ROUTES.me_session_revoke, async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const { sessionId } = await c.req.json<{ sessionId?: unknown }>().catch(() => ({ sessionId: undefined }));
      if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
        return c.json({ error: "sessionId is required" }, 400);
      }
      const revoked = await revokeSignedInSession(c.env, user.id, sessionId);
      await logAuthMetric({ routeGroup: "session_revoke", status: revoked ? 200 : 404, outcome: revoked ? "revoked" : "unknown", userId: user.id });
      return revoked ? c.json({ ok: true }) : c.json({ error: "That session is already signed out" }, 404);
    } catch (error) {
      return failureResponse(requestFailure(error));
    }
  });

  app.post(HUB_ROUTES.me_sessions_revoke_others, async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const { scope } = await c.req.json<{ scope?: unknown }>().catch(() => ({ scope: undefined }));
      if (scope !== "browsers" && scope !== "everything") {
        return c.json({ error: "scope must be browsers or everything" }, 400);
      }
      const current = accessTokenSessionId(readBearerToken(c.req.header("authorization")) ?? undefined);
      const revoked = await revokeOtherSignedInSessions(c.env, user.id, current, scope);
      await logAuthMetric({ routeGroup: "session_revoke_others", status: 200, outcome: scope, userId: user.id });
      return c.json({ revoked });
    } catch (error) {
      return failureResponse(requestFailure(error));
    }
  });
}
