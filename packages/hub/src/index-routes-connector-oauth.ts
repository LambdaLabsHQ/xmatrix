import { dingtalkNativeCompany } from "./connectors/dingtalk-native";
import { teamsNativeApp } from "./connectors/teams-native";
import { telegramNativeApp } from "./connectors/telegram-native";
import { wecomNativeSuite } from "./connectors/wecom-suite";
import { sentryInstallationClient } from "./connectors/sentry-installation";
import { feishuNativeApp } from "./connectors/feishu-native";
import { googleChatNativeApp } from "./connectors/googlechat-native";
import type { Hono } from "hono";
import { HUB_ROUTES } from "@xmatrix/protocol";
import { checkAppConnection } from "./app-connection-check";
import { getAppConnectorProvider } from "./app-connectors";
import { connectorCredentialRepository, INGRESS_KEY_FIELD, mintConnectorSecret } from "./connectors/credentials";
import { exchangeOAuthGrant, oauthAuthorizeUrl, oauthClient, oauthProviderIds, oauthRedirectUri,
  verifyOAuthState } from "./connectors/oauth";
import { appOrigin } from "./deployment-origins";
import { vercelCompletionUrl } from "./connectors/vercel-api";
import { connectorHubOrigin, requireAuth, requireHumanAuth, jsonErrors } from "./index-shared";
import { ControlError } from "@xmatrix/db";
import { getAppConnection, upsertAppConnection } from "./apps";
import type { Env } from "./types";

/*
 * One-click OAuth routes (docs/design/connector-platform.md §3.2): which
 * providers have it, starting it for a Space, the provider's callback, and
 * the signed-in completion. Completion stores the tokens as the admin who
 * started it and only for that admin, so the credential store's owner/admin
 * check still decides.
 */

function appsRedirect(env: Env, spaceId: string, providerId: string, outcome: "connected" | "failed"): string {
  const url = new URL(`/app/${encodeURIComponent(spaceId)}/apps`, appOrigin(env));
  url.searchParams.set("connector", providerId);
  url.searchParams.set("oauth", outcome);
  return url.toString();
}

/** The provider's callback parameters the app passes back to finish a connect. */
const COMPLETION_QUERY_KEYS = ["state", "code", "configurationId", "teamId", "next"] as const;

type VerifiedOAuthState = NonNullable<Awaited<ReturnType<typeof verifyOAuthState>>>;

/** Exchanges the grant, stores and checks the credential; answers where the browser goes next. */
async function completeOAuthConnect(env: Env, request: Request, verified: VerifiedOAuthState, state: string,
  input: { code?: string; configurationId?: string; teamId?: string; next?: string }): Promise<string> {
  const providerId = verified.client.manifest.id;
  if (!input.code) return appsRedirect(env, verified.spaceId, providerId, "failed");
  try {
    if (providerId === "discord") {
      const current = await connectorCredentialRepository(env).installationSnapshot({ requestId: crypto.randomUUID(),
        spaceId: verified.spaceId, providerId: "discord", actorUserId: verified.userId });
      const original = verified.connectionSnapshot;
      if (!original || current.connectionVersion !== original.connectionVersion || current.credentialVersion !== original.credentialVersion ||
          current.connectionGeneration !== original.connectionGeneration) throw new Error("Discord connection changed before installation");
    }
    const grant = await exchangeOAuthGrant(verified.client, input.code, oauthRedirectUri(connectorHubOrigin(env, request)), state);
    const integration = verified.client.manifest.oauth.flow === "vercel-integration";
    const completion = integration ? vercelCompletionUrl({ configurationId: input.configurationId,
      teamId: input.teamId, next: input.next }, grant.fields) : undefined;
    if (integration && !completion) return appsRedirect(env, verified.spaceId, providerId, "failed");
    /* The row comes first because credentials are stored on it; it is not
       Connected until the check below has used the token. */
    if (providerId !== "discord") {
      await upsertAppConnection(env, { commandId: `connector-oauth:${crypto.randomUUID()}`, spaceId: verified.spaceId,
        providerId, actorUserId: verified.userId, body: { status: "disconnected" } });
    }
    const manifest = getAppConnectorProvider(providerId)!;
    const generated = [...(manifest.credentials ?? []).filter(field => field.generated && !field.managed)
      .map(field => field.id), ...(manifest.events ? [INGRESS_KEY_FIELD] : [])];
    await connectorCredentialRepository(env).put({ requestId: crypto.randomUUID(), spaceId: verified.spaceId,
      providerId, actorUserId: verified.userId, fields: grant.fields, oauthInstallation: grant.installation,
      ...(providerId === "discord" ? { expectedInstallationSnapshot: verified.connectionSnapshot } : {}),
      initialize: Object.fromEntries(generated.map(name => [name, mintConnectorSecret()])),
      policy: { allowed: [...(manifest.credentials ?? []).map((field) => field.id), ...generated] },
      at: new Date().toISOString() });
    const checked = await checkAppConnection(env, { spaceId: verified.spaceId, providerId,
      userId: verified.userId, commandId: `connector-oauth-check:${crypto.randomUUID()}` });
    if ((checked as { ok?: unknown }).ok !== true) return appsRedirect(env, verified.spaceId, providerId, "failed");
    return completion ?? appsRedirect(env, verified.spaceId, providerId, "connected");
  } catch (error) {
    console.error("Connector OAuth callback failed", providerId, providerId === "discord" ? "installation rejected" : error instanceof Error ? error.message : "unknown");
    return appsRedirect(env, verified.spaceId, providerId, "failed");
  }
}

export function registerConnectorOAuthRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/connectors/oauth/providers", (c) => jsonErrors(c, async () => {
    requireHumanAuth(await requireAuth(c.req.raw, c.env));
    return c.json({ providers: [...oauthProviderIds(c.env), ...(sentryInstallationClient(c.env) ? ["sentry"] : [])],
      nativeProviders: [...(teamsNativeApp(c.env) ? ["teams"] : []), ...(googleChatNativeApp(c.env) ? ["googlechat"] : []), ...(await feishuNativeApp(c.env) ? ["feishu"] : []), ...(await telegramNativeApp(c.env) ? ["telegram"] : []), ...(await wecomNativeSuite(c.env) ? ["wecom"] : []), ...(await dingtalkNativeCompany(c.env) ? ["dingtalk"] : [])] }, 200, { "cache-control": "private, no-store" });
  }));

  app.post("/api/spaces/:spaceId/app-connections/:providerId/oauth/start", (c) => jsonErrors(c, async () => {
    const authenticated = await requireAuth(c.req.raw, c.env);
    if (authenticated.agentRun) return c.json({ error: "Connecting an app requires a Space admin" }, 403);
    const user = requireHumanAuth(authenticated);
    if (c.req.param("providerId") === "sentry") {
      const native = sentryInstallationClient(c.env);
      if (native) {
        await connectorCredentialRepository(c.env).readGenerated({ requestId: crypto.randomUUID(),
          spaceId: c.req.param("spaceId"), providerId: "sentry", actorUserId: user.id, generated: [] });
        return c.json({ url: `https://sentry.io/sentry-apps/${encodeURIComponent(native.appSlug)}/external-install/` },
          200, { "cache-control": "private, no-store" });
      }
    }
    const client = oauthClient(c.env, c.req.param("providerId"));
    if (!client) return c.json({ error: "One-click connect is not configured for this app" }, 404);
    let connectionSnapshot;
    if (client.manifest.id === "discord") {
      const spaceId = c.req.param("spaceId"), repository = connectorCredentialRepository(c.env);
      await repository.readGenerated({ requestId: crypto.randomUUID(), spaceId, providerId: "discord", actorUserId: user.id, generated: [] });
      const existing = await getAppConnection(c.env, { connectionId: `${spaceId}:discord`, actorUserId: user.id })
        .catch((error: unknown) => { if (error instanceof ControlError && error.status === 404) return null; throw error; });
      if (!existing) {
        await upsertAppConnection(c.env, { commandId: `connector-discord-start:${crypto.randomUUID()}`, spaceId,
          providerId: "discord", actorUserId: user.id, body: { status: "disconnected" } });
      }
      connectionSnapshot = await repository.installationSnapshot({ requestId: crypto.randomUUID(), spaceId,
        providerId: "discord", actorUserId: user.id });
    }
    return c.json({ url: await oauthAuthorizeUrl(client, { spaceId: c.req.param("spaceId"), userId: user.id, connectionSnapshot,
      redirectUri: oauthRedirectUri(connectorHubOrigin(c.env, c.req.raw)) }) }, 200, { "cache-control": "private, no-store" });
  }));

  // The provider's redirect carries no xMatrix session (the app signs in with
  // bearer tokens), so nothing is exchanged here: the signed-in app finishes it.
  app.get("/api/connectors/oauth/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const verified = state ? await verifyOAuthState(c.env, state) : undefined;
    if (!verified) return c.json({ error: "Invalid or expired connect request" }, 400);
    const url = new URL("/connect/oauth", appOrigin(c.env));
    for (const key of COMPLETION_QUERY_KEYS) {
      const value = c.req.query(key);
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return c.redirect(url.toString(), 302);
  });

  /*
   * Exchanges the grant only for the admin who started it. Without this check
   * anyone could send their own connect link to another person, whose
   * approval would store that person's provider account in the sender's Space.
   */
  app.post(HUB_ROUTES.connector_oauth_complete, (c) => jsonErrors(c, async () => {
    const authenticated = await requireAuth(c.req.raw, c.env);
    if (authenticated.agentRun) return c.json({ error: "Connecting an app requires a Space admin" }, 403);
    const user = requireHumanAuth(authenticated);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const field = (key: string) => typeof body?.[key] === "string" ? body[key] as string : undefined;
    const state = field("state") ?? "";
    const verified = state ? await verifyOAuthState(c.env, state) : undefined;
    if (!verified) return c.json({ error: "Invalid or expired connect request" }, 400);
    if (verified.userId !== user.id) {
      return c.json({ error: "This connect request was started by someone else" }, 403);
    }
    return c.json({ redirect: await completeOAuthConnect(c.env, c.req.raw, verified, state, {
      code: field("code"), configurationId: field("configurationId"), teamId: field("teamId"), next: field("next"),
    }) }, 200, { "cache-control": "private, no-store" });
  }));
}
