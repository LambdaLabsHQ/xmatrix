/**
 * Admin side of approval-gated Space invite codes.
 *
 * An invite code that requires approval does not grant membership when it is
 * redeemed; it files a request. These are the two routes an admin needs to see
 * those requests and decide them.
 *
 * They live here rather than beside the other Space routes because
 * `index-routes-auth-space.ts` sits at the repository's 5000-line ceiling.
 */
import type { Context, Hono } from "hono";
import type { Env } from "./types";
import { productCommandId, requireAuth, requestErrorResponse } from "./index-shared";
import { decideSpaceJoinRequest, joinOpenSpace, listSpaceJoinRequests } from "./spaces";

type RouteContext = Context<{ Bindings: Env }>;

/** The routes' one shape: authenticate, then answer what the Space's call returns as the caller. */
async function joinRequestRoute(
  c: RouteContext,
  run: (actorUserId: string) => Promise<Record<string, unknown>>,
): Promise<Response> {
  try {
    const authUser = await requireAuth(c.req.raw, c.env);
    return c.json(await run(authUser.id));
  } catch (error) {
    return requestErrorResponse(c, error);
  }
}

export function registerIndexRoutesSpaceJoinRequests(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/spaces/:spaceId/join", (c) =>
    joinRequestRoute(c, async (actorUserId) => {
      const spaceId = c.req.param("spaceId");
      const authUser = await requireAuth(c.req.raw, c.env);
      return joinOpenSpace(c.env, {
        commandId: productCommandId(c.req.raw, "join-open-space", `${spaceId}:${actorUserId}`),
        spaceId, actorUserId,
        ...(authUser.email ? { email: authUser.email } : {}),
        ...(authUser.name ? { name: authUser.name } : {}),
        ...(authUser.avatarUrl ? { avatarUrl: authUser.avatarUrl } : {}),
      });
    }));

  app.get("/api/spaces/:spaceId/join-requests", (c) =>
    joinRequestRoute(c, async (actorUserId) => {
      // Every pending request, not the first page: an admin cannot approve one
      // they were never shown.
      const joinRequests: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await listSpaceJoinRequests(c.env, { spaceId: c.req.param("spaceId"), actorUserId, limit: 200,
          ...(cursor ? { cursor } : {}) });
        joinRequests.push(...(Array.isArray(page.joinRequests) ? page.joinRequests : []));
        cursor = typeof page.cursor === "string" && page.cursor ? page.cursor : undefined;
      } while (cursor);
      return { joinRequests };
    }));

  app.post("/api/spaces/:spaceId/join-requests/:requestId/decide", (c) =>
    joinRequestRoute(c, async (actorUserId) => {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const requestId = c.req.param("requestId");
      // The owning Space is resolved from the request id.
      return decideSpaceJoinRequest(c.env, {
        commandId: productCommandId(c.req.raw, "decide-space-join-request", requestId),
        joinRequestId: requestId, actorUserId, approve: body.approve === true,
      });
    }));
}
