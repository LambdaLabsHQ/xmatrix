import { HUB_ROUTES, PRIVATE_CONNECTOR_RESULT, type ConnectorResultVisibility } from "@xmatrix/protocol";
import { ControlError } from "@xmatrix/db";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireAgentRunChannelDelegation } from "./agent-run-channel-delegation";
import { AuthFailure, PermissionFailure, readBoundedRequestBody, requireAuth, requireHumanAuth, requestErrorResponse } from "./index-shared";
import { privateResponse } from "./private-response";
import { parseActionCommand } from "./connectors/action-parse";
import { connectorActionCatalog } from "./connectors/action-catalog";
import { callConnectorRead, privateFailure } from "./connectors/connector-commands";
import { connectorForCommand } from "./connectors/registry";
import { ConnectorRemedy, ProviderRequestError } from "./connectors/http";
import { appExecutionRetry } from "./apps";
import { commandResult, publishCommandStatus } from "./connectors/command-support";
import { getAppConnectorProvider } from "./app-connectors";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { ConnectorCommandInput } from "./connectors/provider";
import type { Env } from "./types";
import { readConnectorPrivateResult, writeConnectorPrivateResult } from "./connectors/private-result-content";

const NO_STORE = { "cache-control": "private, no-store" };

/** Recorded calls keep their invocation visible. A private result crosses
 * the calling response and the Human owner’s protected view; shared history receives a mask. */
export function registerConnectorCallRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/channels/:channelId/messages/:messageId/connector-result", async c => {
    try {
      const user = await requireAuth(c.req.raw, c.env);
      if (user.agentRun) return c.json({ error: "Private results require their Human owner" }, 403, NO_STORE);
      return c.json(await readConnectorPrivateResult(c.env, { channelId: c.req.param("channelId"),
        messageId: c.req.param("messageId"), ownerUserId: user.id }), 200, NO_STORE);
    } catch (error) {
      const status = error instanceof ControlError || error instanceof ProviderRequestError ? error.status
        : error instanceof AuthFailure ? 401 : 503;
      return c.json({ error: "Private result is unavailable" }, status as ContentfulStatusCode, NO_STORE);
    }
  });
  app.post(HUB_ROUTES.connector_call, async c => {
    let authorizeCaller: (() => Promise<void>) | undefined;
    try {
      const user = await requireAuth(c.req.raw, c.env);
      const run = user.agentRun;
      if (!run?.instanceId) return c.json({ error: "Connector calls require an Agent Run" }, 403, NO_STORE);
      const authorize = async () => { await requireAgentRunChannelDelegation(c.env, run, []); };
      authorizeCaller = authorize;
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
      const result = await recordedRead(c.env, { channelId: run.channelId, spaceId: run.spaceId, ownerUserId: run.ownerUserId,
        command, visibility: resultVisibility, authorize, sender: { kind: "agent", id: run.instanceId },
        principal: { kind: "agent", id: run.agentId, agentSpaceId: run.spaceId },
        agentRunProof: { runId: run.runId, instanceId: run.instanceId, executionKey: run.executionKey } });
      return c.json(result, 200, NO_STORE);
    } catch (error) {
      if (error instanceof ReceiptUnsaved) return c.json({ error: error.message }, 503, NO_STORE);
      // Provider errors may contain private data too. The receipt applies its
      // chosen visibility; raw exceptions never reach shared error reporting.
      if (error instanceof ProviderRequestError && authorizeCaller) {
        try { await authorizeCaller(); }
        catch (denied) { return privateResponse(requestErrorResponse(c,
          denied instanceof PermissionFailure || denied instanceof AuthFailure ? denied : new Error("Caller access is unavailable"))); }
      }
      if (error instanceof ProviderRequestError) return c.json({ error: error.message },
        (error.status >= 400 && error.status <= 599 ? error.status : 502) as ContentfulStatusCode, NO_STORE);
      const safe = error instanceof ControlError || error instanceof AuthFailure || error instanceof PermissionFailure
        ? error : new Error("Private connector call failed");
      return privateResponse(requestErrorResponse(c, safe));
    }
  });
  /* A person runs a failed read again from where it shows, as themselves and
     with the visibility it had: a private result returns to its owner alone. */
  app.post("/api/spaces/:spaceId/app-executions/:executionId/retry", async c => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const spaceId = c.req.param("spaceId");
      const retry = await appExecutionRetry(c.env, { spaceId, executionId: c.req.param("executionId"), actorUserId: user.id });
      if (!retry.command || !retry.visibility) return c.json({ error: "Only a read can run again" }, 409, NO_STORE);
      if (retry.visibility === "private" && retry.requestedBy !== user.id) {
        return c.json({ error: "Only the person a private call ran for can run it again" }, 403, NO_STORE);
      }
      const result = await recordedRead(c.env, { channelId: retry.channelId, spaceId, ownerUserId: user.id, command: retry.command,
        visibility: retry.visibility, authorize: async () => {}, sender: { kind: "user", id: user.id },
        principal: { kind: "user", id: user.id } });
      return c.json(result, 200, NO_STORE);
    } catch (error) {
      if (error instanceof ProviderRequestError) return c.json({ error: error.message,
        ...(error instanceof ConnectorRemedy && error.fix ? { remedy: error.fix } : {}) },
      (error.status >= 400 && error.status <= 599 ? error.status : 502) as ContentfulStatusCode, NO_STORE);
      if (error instanceof ReceiptUnsaved) return c.json({ error: error.message }, 503, NO_STORE);
      return privateResponse(requestErrorResponse(c, error instanceof ControlError || error instanceof AuthFailure
        || error instanceof PermissionFailure ? error : new Error("The connector call failed")));
    }
  });
}

class ReceiptUnsaved extends Error {}

/** One recorded read: its command message, its execution, a receipt in its
 * Channel (masked when private, the original kept for its Human owner), and
 * the original returned to whoever asked. */
async function recordedRead(env: Env, call: {
  channelId: string; spaceId: string; ownerUserId: string; command: string; visibility: ConnectorResultVisibility;
  authorize: () => Promise<void>; sender: { kind: "agent" | "user"; id: string };
  principal: { kind: "agent"; id: string; agentSpaceId: string } | { kind: "user"; id: string };
  agentRunProof?: { runId: string; instanceId: string; executionKey: string };
}) {
  const provider = connectorForCommand(call.command);
  const parsed = provider && parseActionCommand(provider.id, call.command);
  const action = parsed && connectorActionCatalog(provider!.id, provider!.actions).get(parsed.actionId)?.executor;
  if (!provider || !parsed || !action) throw new ProviderRequestError(400, "Unknown connector action");
  if (action.effect !== "read") throw new ProviderRequestError(403, "Calls support read actions only; use a Channel command for writes");
  const manifest = getAppConnectorProvider(provider.id)!;
  const input: ConnectorCommandInput = { env, channelId: call.channelId, actorUserId: call.ownerUserId,
    senderKind: call.sender.kind, senderId: call.sender.id, messageId: crypto.randomUUID(), body: call.command };
  const appended = await dispatchProductMessageAppend(env, call.channelId, {
    commandId: `connector-call:${input.messageId}`, messageId: input.messageId,
    channelId: call.channelId, body: call.command, principal: call.principal,
    ...(call.agentRunProof ? { agentRunProof: call.agentRunProof } : {}),
    residual: { appMetadata: { xmatrixConnectorResultVisibility: call.visibility } },
  });
  if (!appended.ok) throw new ProviderRequestError(appended.status, "The call's Channel record could not be saved");
  const publish = async (status: "completed" | "failed" | "blocked", summary: string, masked = PRIVATE_CONNECTOR_RESULT) => {
    if (call.visibility === "private") await writeConnectorPrivateResult(env, {
      channelId: call.channelId, spaceId: call.spaceId, ownerUserId: call.ownerUserId,
      messageId: `system:${input.messageId}:${manifest.id}`.slice(0, 200), detail: summary,
    });
    await publishCommandStatus(manifest, input, [commandResult(manifest.name, parsed.actionId, {
      status, summary: call.visibility === "private" ? masked : summary,
    })], { resumeRequester: false,
      ...(call.visibility === "private" ? { privateResultOwnerUserId: call.ownerUserId } : {}) });
  };
  let result;
  try {
    result = await callConnectorRead(provider.id, input, parsed.actionId, action, parsed.statement, call.authorize, call.visibility);
  } catch (error) {
    try {
      await publish(error instanceof ProviderRequestError && error.status === 403 ? "blocked" : "failed",
        error instanceof ProviderRequestError ? error.message : "The connector call failed", privateFailure(error));
    } catch {
      throw new ReceiptUnsaved("The call's Channel receipt could not be saved");
    }
    throw error;
  }
  await publish("completed", `${result.summary}${result.url ? ` — ${result.url}` : ""}`);
  await call.authorize();
  return result;
}
