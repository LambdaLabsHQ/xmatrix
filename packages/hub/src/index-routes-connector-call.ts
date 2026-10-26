import { HUB_ROUTES, PRIVATE_CONNECTOR_RESULT, type AppConnectorProviderManifest,
  type ConnectorResultVisibility } from "@xmatrix/protocol";
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
import { commandResult, publishCommandStatus } from "./connectors/command-support";
import { getAppConnectorProvider } from "./app-connectors";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { ConnectorCommandInput } from "./connectors/provider";
import type { Env } from "./types";

const NO_STORE = { "cache-control": "private, no-store" };

/** Recorded calls keep their invocation visible. A private result crosses
 * only the authenticated response; messages and history receive a fixed mask. */
export function registerConnectorCallRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post(HUB_ROUTES.connector_call, async c => {
    let invocation: { manifest: AppConnectorProviderManifest; input: ConnectorCommandInput;
      actionId: string; visibility: ConnectorResultVisibility } | undefined;
    let receiptAttempted = false;
    const publish = async (status: "completed" | "failed" | "blocked", summary: string) => {
      if (!invocation) return;
      receiptAttempted = true;
      const { manifest, input, actionId, visibility } = invocation;
      await publishCommandStatus(manifest, input, [commandResult(manifest.name, actionId, {
        status, summary: visibility === "private" ? PRIVATE_CONNECTOR_RESULT : summary,
      })], { resumeRequester: false });
    };
    try {
      const user = await requireAuth(c.req.raw, c.env);
      const run = user.agentRun;
      if (!run?.instanceId) return c.json({ error: "Connector calls require an Agent Run" }, 403, NO_STORE);
      const authorize = async () => { await requireAgentRunChannelDelegation(c.env, run, []); };
      await authorize();
      const bytes = await readBoundedRequestBody(c.req.raw, 32 * 1024);
      if (!bytes) return c.json({ error: "Connector call is too large" }, 413, NO_STORE);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* rejected below */ }
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => key !== "command" && key !== "resultVisibility") ||
        typeof (body as { command?: unknown }).command !== "string" ||
        ((body as { resultVisibility?: unknown }).resultVisibility !== "public" &&
          (body as { resultVisibility?: unknown }).resultVisibility !== "private")) {
        return c.json({ error: "Provide a connector command and public or private resultVisibility" }, 400, NO_STORE);
      }
      const { command, resultVisibility } = body as { command: string; resultVisibility: ConnectorResultVisibility };
      const provider = connectorForCommand(command);
      const parsed = provider && parseActionCommand(provider.id, command);
      const action = parsed && connectorActionCatalog(provider!.id, provider!.actions).get(parsed.actionId)?.executor;
      if (!provider || !parsed || !action) return c.json({ error: "Unknown connector action" }, 400, NO_STORE);
      if (action.effect !== "read") return c.json({ error: "Calls support read actions only; use a Channel command for writes" }, 403, NO_STORE);
      const input: ConnectorCommandInput = { env: c.env, channelId: run.channelId,
        actorUserId: run.ownerUserId, senderKind: "agent", senderId: run.instanceId,
        messageId: crypto.randomUUID(), body: command };
      const appended = await dispatchProductMessageAppend(c.env, run.channelId, {
        commandId: `connector-call:${input.messageId}`, messageId: input.messageId,
        channelId: run.channelId, body: command,
        principal: { kind: "agent", id: run.agentId, agentSpaceId: run.spaceId },
        agentRunProof: { runId: run.runId, instanceId: run.instanceId, executionKey: run.executionKey },
        residual: { appMetadata: { xmatrixConnectorResultVisibility: resultVisibility } },
      });
      if (!appended.ok) throw new ProviderRequestError(appended.status, "The call's Channel record could not be saved");
      invocation = { manifest: getAppConnectorProvider(provider.id)!, input,
        actionId: parsed.actionId, visibility: resultVisibility };
      const result = await callConnectorRead(provider.id, input, parsed.actionId, action, parsed.statement, authorize, resultVisibility);
      await publish("completed", `${result.summary}${result.url ? ` — ${result.url}` : ""}`);
      return c.json(result, 200, NO_STORE);
    } catch (error) {
      if (invocation && !receiptAttempted) {
        try {
          await publish(error instanceof ProviderRequestError && error.status === 403 ? "blocked" : "failed",
            error instanceof ProviderRequestError ? error.message : "The connector call failed");
        } catch {
          return c.json({ error: "The call's Channel receipt could not be saved" }, 503, NO_STORE);
        }
      }
      // Provider errors may contain private data too. The receipt applies its
      // chosen visibility; raw exceptions never reach shared error reporting.
      if (error instanceof ProviderRequestError) return c.json({ error: error.message },
        (error.status >= 400 && error.status <= 599 ? error.status : 502) as ContentfulStatusCode, NO_STORE);
      const safe = error instanceof ControlError || error instanceof AuthFailure || error instanceof PermissionFailure
        ? error : new Error("Private connector call failed");
      return privateResponse(requestErrorResponse(c, safe));
    }
  });
}
