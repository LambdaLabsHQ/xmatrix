import type { Hono } from "hono";
import { requireAuth, requestErrorStatus } from "./index-shared";
import type { Env } from "./types";

/** The task-body routing API is retired. A published Channel message is the
 * only public route into an Agent summon. */
export function registerAgentRoutingRoutes(app: Hono<{ Bindings: Env }>,
  authenticate: typeof requireAuth = requireAuth): void {
  for (const action of ["plan", "dispatch"] as const) {
    app.post(`/api/channels/:channelId/agent-routing/${action}`, async c => {
      try {
        await authenticate(c.req.raw, c.env);
        return c.json({ code: "routing_endpoint_retired",
          error: "Send a Channel message with @auto or a harness mention." }, 410,
        { "cache-control": "private, no-store" });
      } catch (error) {
        return c.json({ error: "Routing request unavailable" }, requestErrorStatus(error),
          { "cache-control": "private, no-store" });
      }
    });
  }
}
