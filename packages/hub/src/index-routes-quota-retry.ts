import type { Hono } from "hono";
import type { Env } from "./types";
import { requireAuth, requireHumanAuth, jsonErrors } from "./index-shared";
import { quotaRetryRepository } from "./agent-quota-retry";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
export function registerQuotaRetryRoutes(
  app: Hono<{
    Bindings: Env;
  }>,
): void {
  const path = "/api/channels/:channelId/quota-retries/:retryId";
  app.get(path, (c) =>
    jsonErrors(c, async () => {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const { repository } = await quotaRetryRepository(c.env, c.req.param("channelId"));
      return c.json(
        await repository.read({
          channelId: c.req.param("channelId"),
          actorUserId: user.id,
          id: c.req.param("retryId"),
        }),
        200,
        { "cache-control": "private, no-store" },
      );
    }),
  );
  app.post(path, (c) =>
    jsonErrors(c, async () => {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const body = (await c.req.json().catch(() => null)) as {
        action?: unknown;
      } | null;
      if (
        !body ||
        Object.keys(body).some((k) => k !== "action") ||
        (body.action !== "wait" && body.action !== "cancel")
      )
        return c.json({ error: "Invalid quota retry choice" }, 400);
      const channelId = c.req.param("channelId"),
        id = c.req.param("retryId");
      const { repository } = await quotaRetryRepository(c.env, channelId);
      await repository.choose({
        channelId,
        actorUserId: user.id,
        id,
        action: body.action,
      });
      await wakeAgentLaunchCoordinator(c.env, channelId, ["quotaRetry"]);
      return c.json(await repository.read({ channelId, actorUserId: user.id, id }), 202, {
        "cache-control": "private, no-store",
      });
    }),
  );
}
