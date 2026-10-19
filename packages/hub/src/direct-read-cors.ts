import type { Hono } from "hono";
import { CLIENT_COMPATIBILITY_HEADERS } from "@xmatrix/protocol";
import { appOrigin } from "./deployment-origins";
import { appendVary } from "./index-shared";
import type { Env } from "./types";

/**
 * Reads the Web app makes straight to the Hub, as it already opens live page
 * sessions and signs in, instead of through its own Worker: a page's text,
 * margin, sections, claims and Automations, and a conversation's history.
 * Only the app's own origin is answered, with a bearer token and the client
 * identity in headers and never a cookie, so this widens no access: each
 * route still authorizes the bearer exactly as it does through the Web.
 */
const DIRECT_READ_PATHS: readonly RegExp[] = [
  /^\/api\/spaces\/[^/]+\/pages$/u,
  /^\/api\/spaces\/[^/]+\/pages\/recent-changes$/u,
  /^\/api\/spaces\/[^/]+\/pages\/[^/]+$/u,
  /^\/api\/spaces\/[^/]+\/pages\/[^/]+\/(?:awareness|claims|automations|suggestions|read)$/u,
  /^\/api\/spaces\/[^/]+\/page-links(?:\/agents)?$/u,
  /^\/api\/channels\/[^/]+\/history$/u,
];

/** A browser may keep the answer to a preflight this long; Chrome keeps it two hours at most. */
const PREFLIGHT_MAX_AGE_SECONDS = 7200;

const ALLOWED_HEADERS = ["authorization", ...Object.values(CLIENT_COMPATIBILITY_HEADERS)].join(", ");

/** The app's origin when `request` is one of its direct reads (or their preflight), else null. */
function directReadOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  if (!origin || (request.method !== "GET" && request.method !== "OPTIONS")) return null;
  if (request.method === "OPTIONS" && request.headers.get("access-control-request-method") !== "GET") return null;
  let allowed: string;
  try {
    allowed = appOrigin(env);
  } catch {
    return null;
  }
  if (origin !== allowed) return null;
  const pathname = new URL(request.url).pathname;
  return DIRECT_READ_PATHS.some((path) => path.test(pathname)) ? allowed : null;
}

/** Answers the app's direct reads across origins; registered before every route, the preflight included. */
export function registerDirectReadCors(app: Hono<{ Bindings: Env }>): void {
  app.use("/api/*", async (context, next) => {
    const origin = directReadOrigin(context.req.raw, context.env);
    if (!origin) return next();
    if (context.req.method === "OPTIONS") {
      const headers = new Headers({
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET",
        "access-control-allow-headers": ALLOWED_HEADERS,
        "access-control-max-age": String(PREFLIGHT_MAX_AGE_SECONDS),
      });
      appendVary(headers, "Origin, Access-Control-Request-Headers");
      return new Response(null, { status: 204, headers });
    }
    await next();
    // A route may answer with a response whose headers cannot change.
    const response = new Response(context.res.body, context.res);
    response.headers.set("access-control-allow-origin", origin);
    appendVary(response.headers, "Origin");
    context.res = response;
  });
}
