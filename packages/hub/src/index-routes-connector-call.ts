import { HUB_ROUTES, utf8ByteLength } from "@xmatrix/protocol";
import { ControlError } from "@xmatrix/db";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireAgentRunChannelDelegation } from "./agent-run-channel-delegation";
import { AuthFailure, PermissionFailure, readBoundedRequestBody, requireAuth, requestErrorResponse } from "./index-shared";
import { privateResponse } from "./private-response";
import { parseActionCommand } from "./connectors/action-parse";
import { connectorActionCatalog } from "./connectors/action-catalog";
import { callConnectorRead } from "./connectors/connector-commands";
import { connectorForCommand } from "./connectors/registry";
import { ProviderRequestError } from "./connectors/http";
import type { Env } from "./types";

const NO_STORE = { "cache-control": "private, no-store" };

/** Request/response delivery only. There is no stored response reference for
 * another Channel member or Instance to retrieve, and no request/result logging. */
export function registerConnectorCallRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post(HUB_ROUTES.connector_call, async c => {
    try {
      const user = await requireAuth(c.req.raw, c.env);
      const run = user.agentRun;
      if (!run?.instanceId) return c.json({ error: "Private connector calls require an Agent Run" }, 403, NO_STORE);
      const authorize = async () => { await requireAgentRunChannelDelegation(c.env, run, []); };
      await authorize();
      const bytes = await readBoundedRequestBody(c.req.raw, 32 * 1024);
      if (!bytes) return c.json({ error: "Connector call is too large" }, 413, NO_STORE);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* rejected below */ }
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => key !== "command") ||
        typeof (body as { command?: unknown }).command !== "string") {
        return c.json({ error: "Provide only a connector command" }, 400, NO_STORE);
      }
      const command = (body as { command: string }).command;
      const provider = connectorForCommand(command);
      const parsed = provider && parseActionCommand(provider.id, command);
      const action = parsed && connectorActionCatalog(provider!.id, provider!.actions).get(parsed.actionId)?.executor;
      if (!provider || !parsed || !action) return c.json({ error: "Unknown connector action" }, 400, NO_STORE);
      const result = await callConnectorRead(provider.id, { env: c.env, channelId: run.channelId,
        actorUserId: run.ownerUserId, senderKind: "agent", senderId: run.instanceId,
        messageId: crypto.randomUUID(), body: "" }, parsed.actionId, action, parsed.statement, authorize);
      if (utf8ByteLength(JSON.stringify(result)) > 256 * 1024) {
        return c.json({ error: "Private connector result is too large; narrow the request" }, 413, NO_STORE);
      }
      return c.json(result, 200, NO_STORE);
    } catch (error) {
      // Provider errors may contain private data too. Return them only to this
      // request and never forward an exception to shared logging or receipts.
      if (error instanceof ProviderRequestError) return c.json({ error: error.message },
        (error.status >= 400 && error.status <= 599 ? error.status : 502) as ContentfulStatusCode, NO_STORE);
      const safe = error instanceof ControlError || error instanceof AuthFailure || error instanceof PermissionFailure
        ? error : new Error("Private connector call failed");
      return privateResponse(requestErrorResponse(c, safe));
    }
  });
}
