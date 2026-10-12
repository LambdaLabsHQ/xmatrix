import type { Context, Hono } from "hono";
import { InvalidAuthTokenError, verifyMcpAccessToken } from "./auth";
import { createAuth } from "./better-auth";
import { hubAuthBaseUrl } from "./deployment-origins";
import { readBoundedRequestBody } from "./index-shared";
import { MCP_PATH, MCP_SCOPES, mcpResource } from "./mcp-oauth";
import { mcpServer } from "./mcp-server";
import type { Env } from "./types";

/**
 * The MCP endpoint outside AI apps connect to (docs/design/mcp-server.md),
 * and the discovery documents that tell them where to sign in: protected
 * resource metadata (RFC 9728) here, and the authorization server metadata
 * (RFC 8414) that Better Auth serves under /api/auth, published at the root.
 */

const MAX_MCP_REQUEST_BYTES = 256 * 1024;
const RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

/** Any origin may call these: they are bearer-token or public, never cookie, requests. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-expose-headers": "www-authenticate",
} as const;

function unauthorized(env: Env, error?: "invalid_token" | "insufficient_scope"): Response {
  const challenge = [`resource_metadata="${hubAuthBaseUrl(env)}${RESOURCE_METADATA_PATH}"`,
    ...(error ? [`error="${error}"`] : []), `scope="${MCP_SCOPES[0]}"`].join(", ");
  return Response.json({ error: error ?? "unauthorized" }, {
    status: error === "insufficient_scope" ? 403 : 401, headers: { ...CORS, "www-authenticate": `Bearer ${challenge}` },
  });
}

function protectedResourceMetadata(c: Context<{ Bindings: Env }>): Response {
  return c.json({
    resource: mcpResource(c.env),
    resource_name: "xMatrix",
    authorization_servers: [hubAuthBaseUrl(c.env)],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
  }, 200, { ...CORS, "cache-control": "public, max-age=3600" });
}

/**
 * Better Auth answers its metadata documents at the issuer's root path itself
 * (the provider's request hook), outside its /api/auth routes.
 */
async function authorizationServerMetadata(c: Context<{ Bindings: Env }>): Promise<Response> {
  const response = await createAuth(c.env).handler(new Request(c.req.url, { headers: c.req.raw.headers }));
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

export function registerMcpRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get(RESOURCE_METADATA_PATH, protectedResourceMetadata);
  app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
  app.get("/.well-known/openid-configuration", authorizationServerMetadata);
  for (const path of ["/.well-known/oauth-protected-resource", RESOURCE_METADATA_PATH,
    "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", MCP_PATH]) {
    app.options(path, () => new Response(null, { status: 204, headers: CORS }));
  }

  // No server-sent stream: every answer comes back on the POST that asked.
  app.get(MCP_PATH, () => new Response(null, { status: 405, headers: { ...CORS, allow: "POST" } }));

  app.post(MCP_PATH, async (c) => {
    const bearer = /^Bearer\s+(\S+)$/iu.exec(c.req.header("authorization") ?? "")?.[1];
    if (!bearer) return unauthorized(c.env);
    let caller;
    try {
      caller = await verifyMcpAccessToken(bearer, c.env, mcpResource(c.env));
    } catch (error) {
      if (error instanceof InvalidAuthTokenError) return unauthorized(c.env, "invalid_token");
      throw error;
    }
    if (!caller.scopes.includes("xmatrix:read")) return unauthorized(c.env, "insufficient_scope");
    const bytes = await readBoundedRequestBody(c.req.raw, MAX_MCP_REQUEST_BYTES);
    if (!bytes) return c.json({ error: "Request is too large" }, 413, CORS);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 200, CORS);
    }
    const response = await mcpServer(c.env, caller)(body);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  });
}
