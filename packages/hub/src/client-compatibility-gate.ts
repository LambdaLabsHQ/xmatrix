import type { Hono } from "hono";
import {
  CLIENT_COMPATIBILITY_HEADERS,
  CLIENT_COMPATIBILITY_PATH,
  evaluateClientCompatibility,
  missingClientCompatibilityDecision,
  parseClientCompatibilityIdentity,
  type ClientCompatibilityDecision,
} from "@xmatrix/protocol";
import type { Env } from "./types";

const PROTECTED_SOCKET_PATHS = new Set([
  "/ws/humans",
  "/ws/agent-instances",
  "/ws/machine-daemons",
  "/ws/relay-v2-runtime",
]);

export function registerClientCompatibilityGate(app: Hono<{ Bindings: Env }>): void {
  app.use("*", async (context, next) => {
    const request = context.req.raw;
    const pathname = new URL(request.url).pathname;
    if (pathname === CLIENT_COMPATIBILITY_PATH) {
      return compatibilityResponse(clientCompatibilityDecisionForRequest(request), request);
    }
    if (!clientCompatibilityRequired(request)) return next();
    const decision = clientCompatibilityDecisionForRequest(request);
    if (
      decision.reason === "identity_missing" &&
      legacyClientCompatibilityAdmissionEnabled(context.env)
    ) return next();
    if (!decision.compatible) return compatibilityResponse(decision, request);
    return next();
  });
}

export function legacyClientCompatibilityAdmissionEnabled(env: Pick<Env,
  "CLIENT_COMPATIBILITY_LEGACY_ADMISSION_ENABLED"
>): boolean {
  return env.CLIENT_COMPATIBILITY_LEGACY_ADMISSION_ENABLED === "true";
}

export function clientCompatibilityDecisionForRequest(request: Request): ClientCompatibilityDecision {
  const candidate = clientCompatibilityCandidateForRequest(request);
  const identity = parseClientCompatibilityIdentity(candidate);
  if (identity) return evaluateClientCompatibility(identity);
  const component = candidate.component?.trim();
  const version = candidate.version?.trim();
  const protocol = candidate.protocolVersion?.trim();
  const platform = candidate.platform?.trim();
  if (!component && !version && !protocol && !platform) {
    return missingClientCompatibilityDecision();
  }
  return evaluateClientCompatibility({ component, version, protocolVersion: protocol, platform });
}

function clientCompatibilityCandidateForRequest(request: Request): {
  component: string | null;
  version: string | null;
  protocolVersion: string | null;
  platform: string | null;
} {
  const fromHeaders = {
    component: request.headers.get(CLIENT_COMPATIBILITY_HEADERS.component),
    version: request.headers.get(CLIENT_COMPATIBILITY_HEADERS.version),
    protocolVersion: request.headers.get(CLIENT_COMPATIBILITY_HEADERS.protocol),
    platform: request.headers.get(CLIENT_COMPATIBILITY_HEADERS.platform),
  };
  if (Object.values(fromHeaders).some((value) => value !== null)) return fromHeaders;

  const url = new URL(request.url);
  if (!PROTECTED_SOCKET_PATHS.has(url.pathname)) return fromHeaders;
  return {
    component: url.searchParams.get(CLIENT_COMPATIBILITY_HEADERS.component),
    version: url.searchParams.get(CLIENT_COMPATIBILITY_HEADERS.version),
    protocolVersion: url.searchParams.get(CLIENT_COMPATIBILITY_HEADERS.protocol),
    platform: url.searchParams.get(CLIENT_COMPATIBILITY_HEADERS.platform),
  };
}

export function clientCompatibilityRequired(request: Request): boolean {
  if (request.method === "OPTIONS") return false;
  const pathname = new URL(request.url).pathname;
  if (pathname === CLIENT_COMPATIBILITY_PATH) return false;
  if (pathname.startsWith("/api/auth/") || pathname.startsWith("/api/admin/")) return false;
  if (pathname === "/api/apps/github/setup" || pathname === "/api/apps/github/webhook") return false;
  if (/^\/api\/connectors\/[^/]+\/events\//u.test(pathname) || pathname === "/api/connectors/mcp" ||
      pathname === "/api/connectors/oauth/callback") return false;
  if (pathname === "/api/migrations/slack/oauth/callback") return false;
  if (PROTECTED_SOCKET_PATHS.has(pathname)) return true;
  return /^Bearer\s+\S+/iu.test(request.headers.get("authorization") ?? "");
}

export function compatibilityResponse(
  decision: ClientCompatibilityDecision,
  request?: Request,
): Response {
  const origin = request?.headers.get("origin")?.trim();
  return Response.json(decision, {
    status: decision.compatible ? 200 : 426,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      vary: [
        ...Object.values(CLIENT_COMPATIBILITY_HEADERS),
        ...(origin ? ["Origin"] : []),
      ].join(", "),
      ...(origin ? { "access-control-allow-origin": origin } : {}),
    },
  });
}
