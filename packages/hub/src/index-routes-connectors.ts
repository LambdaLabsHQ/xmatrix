import { handleDiscordLifecycleDelivery } from "./connectors/discord-events";
import { registerTeamsRoutes } from "./index-routes-teams";
import { handleTeamsAppDelivery } from "./connectors/teams-ingress";
import { handleDingTalkSuiteCallback } from "./connectors/dingtalk-suite";
import { handleDingTalkSyncHTTP } from "./connectors/dingtalk-synchttp-ingress";
import { registerDingTalkRoutes } from "./index-routes-dingtalk";
import type { Hono } from "hono";
import { HUB_ROUTES } from "@xmatrix/protocol";
import { getAppConnectorProvider } from "./app-connectors";
import { connectorActionPolicyRepository, connectorIngressUrl, connectorCredentialRepository, INGRESS_KEY_FIELD,
  mintConnectorSecret } from "./connectors/credentials";
import { handleAppConnectorDelivery, handleConnectorDelivery } from "./connectors/event-ingress";
import { handleSentryInstallationDelivery } from "./connectors/sentry-app-lifecycle";
import { handleVercelAppDelivery } from "./connectors/vercel-app-ingress";
import { handleGoogleChatAppDelivery } from "./connectors/googlechat-ingress";
import { handleFeishuAppDelivery } from "./connectors/feishu-ingress";
import { handleWeComSuiteCallback } from "./connectors/wecom-suite";
import { handleWeComAppDelivery } from "./connectors/wecom-ingress";
import { handleTelegramAppDelivery } from "./connectors/telegram-ingress";
import { registerTelegramRoutes } from "./index-routes-telegram";
import { registerWeComRoutes } from "./index-routes-wecom";
import { registerFeishuRoutes } from "./index-routes-feishu";
import { registerGoogleChatRoutes } from "./index-routes-googlechat";
import { handleConnectorMcp } from "./connectors/mcp";
import { isPolicyAction } from "./connectors/connector-commands";
import { connectorProvider } from "./connectors/registry";
import { connectorHubOrigin, readBoundedRequestBody, requestErrorStatus, requireAuth, requireHumanAuth, requireLiveAgentRun } from "./index-shared";
import type { AuthUser } from "./auth";
import type { Env } from "./types";

/*
 * Connector credentials and event ingress (docs/design/connector-platform.md
 * §3.2–3.3). Credentials are written by Space owners and admins and never read
 * back, except the values the Hub generated for them to paste into a provider
 * (the ingress URL and any `generated` secret).
 */

const MAX_CREDENTIAL_REQUEST_BYTES = 32 * 1024;


function credentialPolicy(providerId: string) {
  const manifest = getAppConnectorProvider(providerId);
  if (!manifest || manifest.status !== "available") return undefined;
  const declared = manifest.credentials ?? [];
  const generated = [...declared.filter((field) => field.generated && !field.managed).map((field) => field.id),
    ...(manifest.events && !["googlechat", "wecom", "teams"].includes(providerId) ? [INGRESS_KEY_FIELD] : [])];
  const writable = declared.filter((field) => !field.generated && !field.managed).map((field) => field.id);
  if (generated.length === 0 && writable.length === 0) return undefined;
  return { manifest, generated, writable, allowed: [...writable, ...generated] };
}

function credentialView(env: Env, request: Request, providerId: string, spaceId: string,
  generated: Record<string, string>) {
  const { [INGRESS_KEY_FIELD]: ingressKey, ...secrets } = generated;
  return {
    ...(ingressKey ? { ingressUrl: connectorIngressUrl(connectorHubOrigin(env, request), providerId, spaceId, ingressKey) } : {}),
    generated: secrets,
  };
}

function errorResponse(error: unknown): Response {
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status : requestErrorStatus(error);
  return Response.json({ error: error instanceof Error ? error.message : "Connector request failed" }, { status });
}

export function registerConnectorRoutes(app: Hono<{ Bindings: Env }>): void {
  registerDingTalkRoutes(app);
  registerTeamsRoutes(app);
  registerGoogleChatRoutes(app);
  registerFeishuRoutes(app);
  registerTelegramRoutes(app);
  registerWeComRoutes(app);
  app.on(["GET", "POST"], "/api/connectors/dingtalk/suite", c => handleDingTalkSuiteCallback(c.env, c.req.raw));
  app.post("/api/connectors/dingtalk/events", c => handleDingTalkSyncHTTP(c.env, c.req.raw));
  app.on(["GET", "POST"], "/api/connectors/wecom/suite", c => handleWeComSuiteCallback(c.env, c.req.raw));
  app.on(["GET", "POST"], "/api/connectors/wecom/events", c => handleWeComAppDelivery(c.env, c.req.raw));
  app.post("/api/connectors/:providerId/events", async (c) => {
    try {
      if (c.req.param("providerId") === "discord") return await handleDiscordLifecycleDelivery(c.env, c.req.raw);
      if (c.req.param("providerId") === "sentry") return await handleSentryInstallationDelivery(c.env, c.req.raw, work => c.executionCtx.waitUntil(work));
      if (c.req.param("providerId") === "vercel") return await handleVercelAppDelivery({ env: c.env, request: c.req.raw });
      if (c.req.param("providerId") === "teams") return await handleTeamsAppDelivery(c.env, c.req.raw);
      if (c.req.param("providerId") === "googlechat") return await handleGoogleChatAppDelivery(c.env, c.req.raw);
      if (c.req.param("providerId") === "telegram") return await handleTelegramAppDelivery(c.env, c.req.raw);
      if (c.req.param("providerId") === "feishu") return await handleFeishuAppDelivery(c.env, c.req.raw);
      return await handleAppConnectorDelivery({ env: c.env, request: c.req.raw,
        provider: connectorProvider(c.req.param("providerId")) });
    } catch {
      // Do not expose provider payloads, workspace ids, or credentials in logs/errors.
      return Response.json({ error: "Connector ingress is unavailable" }, { status: 503 });
    }
  });

  app.post("/api/connectors/:providerId/events/:spaceId/:ingressKey", async (c) => {
    try {
      return await handleConnectorDelivery({ env: c.env, request: c.req.raw,
        provider: connectorProvider(c.req.param("providerId")), spaceId: c.req.param("spaceId"),
        ingressKey: c.req.param("ingressKey") });
    } catch (error) {
      console.error("Connector ingress failed", error instanceof Error ? error.message : "unknown");
      return Response.json({ error: "Connector ingress is unavailable" }, { status: 503 });
    }
  });

  app.post(HUB_ROUTES.connectors_mcp, async (c) => {
    try {
      const authenticated = await requireAuth(c.req.raw, c.env);
      if (!authenticated.agentRun) return c.json({ error: "Connector tools are for Agent Runs" }, 403);
      const run = await requireLiveAgentRun(c.env, authenticated);
      const bytes = await readBoundedRequestBody(c.req.raw, MAX_CREDENTIAL_REQUEST_BYTES);
      if (!bytes) return c.json({ error: "Request is too large" }, 413);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch {
        return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      return await handleConnectorMcp(c.env, { ownerUserId: run.ownerUserId, channelId: run.channelId,
        runId: run.runId, spaceId: run.spaceId }, body);
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get("/api/spaces/:spaceId/app-connections/:providerId/policies", async (c) => {
    try {
      const authenticated = await requireAuth(c.req.raw, c.env);
      if (authenticated.agentRun) return c.json({ error: "Connector policy is for Space members" }, 403);
      const user = requireHumanAuth(authenticated);
      const policies = await connectorActionPolicyRepository(c.env).list({ requestId: crypto.randomUUID(),
        spaceId: c.req.param("spaceId"), providerId: c.req.param("providerId"), actorUserId: user.id });
      return c.json({ policies }, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.put("/api/spaces/:spaceId/app-connections/:providerId/policies", async (c) => {
    try {
      const authenticated = await requireAuth(c.req.raw, c.env);
      if (authenticated.agentRun) return c.json({ error: "Connector policy requires a Space admin" }, 403);
      const user = requireHumanAuth(authenticated);
      const manifest = getAppConnectorProvider(c.req.param("providerId"));
      const bytes = await readBoundedRequestBody(c.req.raw, 4_096);
      if (!manifest || !bytes) return c.json({ error: "Invalid connector policy request" }, 400);
      let body: { channelId?: unknown; actionId?: unknown; mode?: unknown };
      try { body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body; } catch {
        return c.json({ error: "Invalid connector policy request" }, 400);
      }
      const actionId = typeof body.actionId === "string" ? body.actionId : "";
      if (!isPolicyAction(manifest, actionId)) {
        return c.json({ error: `${actionId || "action"} is not a ${manifest.name} write action` }, 400);
      }
      if (body.mode !== "allow" && body.mode !== "deny" && body.mode !== null) {
        return c.json({ error: "mode is allow, deny or null" }, 400);
      }
      const result = await connectorActionPolicyRepository(c.env).set({ requestId: crypto.randomUUID(),
        spaceId: c.req.param("spaceId"), providerId: manifest.id, channelId: String(body.channelId ?? ""), actionId,
        mode: body.mode, actorUserId: user.id, at: new Date().toISOString() });
      return c.json(result);
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get("/api/spaces/:spaceId/app-connections/:providerId/credentials", (c) =>
    credentialRoute(c.req.raw, c.env, c.req.param("spaceId"), c.req.param("providerId"),
      async ({ readGenerated, view }) => view(await readGenerated())));

  app.put("/api/spaces/:spaceId/app-connections/:providerId/credentials", (c) =>
    credentialRoute(c.req.raw, c.env, c.req.param("spaceId"), c.req.param("providerId"),
      async ({ user, policy, readGenerated, view }) => {
        const bytes = await readBoundedRequestBody(c.req.raw, MAX_CREDENTIAL_REQUEST_BYTES);
        if (!bytes) return c.json({ error: "Connector credential request is too large" }, 413);
        let body: { fields?: unknown; regenerate?: unknown };
        try { body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body; } catch {
          return c.json({ error: "Invalid connector credential request" }, 400);
        }
        const fields: Record<string, string | null> = {};
        if (body.fields !== undefined) {
          if (!body.fields || typeof body.fields !== "object" || Array.isArray(body.fields)) {
            return c.json({ error: "fields is invalid" }, 400);
          }
          for (const [name, value] of Object.entries(body.fields as Record<string, unknown>)) {
            if (!policy.writable.includes(name)) return c.json({ error: `${name} cannot be written` }, 400);
            if (value !== null && typeof value !== "string") return c.json({ error: `${name} is invalid` }, 400);
            fields[name] = typeof value === "string" ? value.trim() || null : null;
          }
        }
        const regenerate = Array.isArray(body.regenerate) ? body.regenerate.map(String) : [];
        if (regenerate.some((name) => !policy.generated.includes(name))) {
          return c.json({ error: "regenerate names a field the Hub does not generate" }, 400);
        }
        const existing = await readGenerated();
        for (const name of policy.generated) {
          if (!existing[name] || regenerate.includes(name)) fields[name] = mintConnectorSecret();
        }
        if (Object.keys(fields).length === 0) return c.json({ error: "Nothing to write" }, 400);
        const result = await connectorCredentialRepository(c.env).put({ requestId: crypto.randomUUID(),
          spaceId: c.req.param("spaceId"), providerId: policy.manifest.id, actorUserId: user.id, fields,
          policy: { allowed: policy.allowed }, at: new Date().toISOString() });
        return view(await readGenerated(), { credentialFields: result.credentialFields });
      }));
}

type CredentialPolicy = NonNullable<ReturnType<typeof credentialPolicy>>;

/* A Human (never an Agent Run) asking about a provider that keeps credentials;
   the credential store itself checks the Space owner/admin role. */
async function credentialRoute(request: Request, env: Env, spaceId: string, providerId: string,
  handle: (context: {
    user: AuthUser;
    policy: CredentialPolicy;
    readGenerated: () => Promise<Record<string, string>>;
    view: (generated: Record<string, string>, extra?: Record<string, unknown>) => Response;
  }) => Promise<Response>): Promise<Response> {
  try {
    const authenticated = await requireAuth(request, env);
    if (authenticated.agentRun) {
      return Response.json({ error: "Connector credentials require a Space admin" }, { status: 403 });
    }
    const user = requireHumanAuth(authenticated);
    const policy = credentialPolicy(providerId);
    if (!policy) return Response.json({ error: "Connector has no credentials" }, { status: 404 });
    return await handle({
      user,
      policy,
      readGenerated: () => connectorCredentialRepository(env).readGenerated({ requestId: crypto.randomUUID(),
        spaceId, providerId: policy.manifest.id, actorUserId: user.id, generated: policy.generated }),
      view: (generated, extra = {}) => Response.json({ ...extra,
        ...credentialView(env, request, policy.manifest.id, spaceId, generated) },
      { headers: { "cache-control": "private, no-store" } }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
