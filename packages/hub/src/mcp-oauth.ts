import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { appOrigin, hubAuthBaseUrl } from "./deployment-origins";
import type { Env } from "./types";

/**
 * The Hub as the OAuth 2.1 authorization server for outside AI apps
 * (ChatGPT, Grok, Cursor) that reach a person's pages and channels through
 * the Hub's MCP endpoint (docs/design/mcp-server.md). Clients register
 * themselves (RFC 7591), sign the person in on the Web app, ask their consent
 * and receive a JWT access token whose audience is the MCP endpoint only, so
 * it never works on the Hub's own API.
 */

/** What an outside app may be granted: reading, and writing as the person. */
export const MCP_SCOPES = ["xmatrix:read", "xmatrix:write"] as const;

export const MCP_PATH = "/mcp";

/** The MCP endpoint: the only resource these tokens are for. */
export function mcpResource(env: Pick<Env, "HUB_URL">): string {
  return `${hubAuthBaseUrl(env)}${MCP_PATH}`;
}

const POSTGRES_MODELS: Record<string, string> = {
  oauthClient: "control.auth_oauth_clients",
  oauthRefreshToken: "control.auth_oauth_refresh_tokens",
  oauthAccessToken: "control.auth_oauth_access_tokens",
  oauthConsent: "control.auth_oauth_consents",
};

const snake = (name: string) => name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

/**
 * A token request that names no resource still gets a token for the MCP
 * endpoint: it is the Hub's only protected resource, and an opaque token
 * would be one no resource of ours accepts.
 */
function mcpDefaultResource(env: Env): BetterAuthPlugin {
  return {
    id: "xmatrix-mcp-resource",
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/oauth2/token",
        handler: createAuthMiddleware(async (ctx) => {
          const body = ctx.body as Record<string, unknown> | undefined;
          if (body && body.resource === undefined) body.resource = mcpResource(env);
        }),
      }],
    },
  };
}

/**
 * Removing an app ends its grant, not only the record that it was allowed:
 * its refresh tokens go with the consent, so it cannot mint another access
 * token, and the one it holds expires within accessTokenExpiresIn.
 */
const mcpRevokeOnRemoval: BetterAuthPlugin = {
  id: "xmatrix-mcp-revoke-on-removal",
  hooks: {
    after: [{
      matcher: (ctx) => ctx.path === "/oauth2/delete-consent",
      handler: createAuthMiddleware(async (ctx) => {
        const userId = ctx.context.session?.user.id;
        if (!userId) return;
        // Every grant of this person's that no consent backs any longer.
        const consented = new Set((await ctx.context.adapter.findMany<{ clientId: string }>({
          model: "oauthConsent", where: [{ field: "userId", value: userId }] })).map((consent) => consent.clientId));
        const held = await ctx.context.adapter.findMany<{ clientId: string }>({
          model: "oauthRefreshToken", where: [{ field: "userId", value: userId }] });
        for (const clientId of new Set(held.map((token) => token.clientId).filter((id) => !consented.has(id)))) {
          for (const model of ["oauthAccessToken", "oauthRefreshToken"]) {
            await ctx.context.adapter.deleteMany({ model, where: [
              { field: "userId", value: userId }, { field: "clientId", value: clientId }] });
          }
        }
      }),
    }],
  },
};

export function mcpOAuthPlugins(env: Env): BetterAuthPlugin[] {
  const provider = oauthProvider({
    loginPage: `${appOrigin(env)}/oauth/authorize`,
    consentPage: `${appOrigin(env)}/oauth/consent`,
    scopes: ["openid", "profile", "email", "offline_access", ...MCP_SCOPES],
    clientRegistrationDefaultScopes: ["openid", "offline_access", "xmatrix:read"],
    clientRegistrationAllowedScopes: ["profile", "email", "xmatrix:write"],
    validAudiences: [mcpResource(env)],
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // Short-lived, so withdrawing consent ends an app's access within minutes.
    accessTokenExpiresIn: 900,
    // The MCP endpoint names the person the way a session token does.
    customAccessTokenClaims: ({ user }) => user ? {
      email: user.email,
      user_metadata: { name: user.name, avatar_url: user.image ?? undefined },
    } : {},
    silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
  });
  const schema = Object.fromEntries(Object.entries(provider.schema ?? {}).map(([model, definition]) => [model, {
    ...definition,
    modelName: POSTGRES_MODELS[model] ?? (() => { throw new Error(`No PostgreSQL table for OAuth model ${model}`); })(),
    fields: Object.fromEntries(Object.entries(definition.fields).map(([field, attribute]) =>
      [field, { ...attribute, fieldName: snake(field) }])),
  }]));
  return [{ ...provider, schema } as BetterAuthPlugin, mcpDefaultResource(env), mcpRevokeOnRemoval];
}
