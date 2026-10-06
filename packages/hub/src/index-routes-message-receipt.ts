import { Hono } from "hono";
import type { Env } from "./types";
import { requireAuth, requestErrorResponse } from "./index-shared";
import { postgresMessageErrorResponse, postgresMessageReceipt } from "./postgres-message-authority";
import { messageReceiptSelection } from "./message-receipt-selection";

export function registerMessageReceiptRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/channels/:channelId/messages/receipt", async (c) => {
    let user: Awaited<ReturnType<typeof requireAuth>>;
    try { user = await requireAuth(c.req.raw, c.env); }
    catch (error) { return requestErrorResponse(c, error); }
    const selection = messageReceiptSelection(c.req.param("channelId"), await c.req.json().catch(() => null), user);
    if (!selection.ok) return c.json({ error: selection.error }, selection.status);
    try {
      const report = await postgresMessageReceipt(c.env, selection.input);
      return c.json(report, 200, { "cache-control": "private, no-store" });
    } catch (error) { return postgresMessageErrorResponse(error); }
  });
}
