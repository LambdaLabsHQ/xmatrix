import type { Hono } from "hono";
import { CLIENT_COMPATIBILITY_HEADERS } from "@xmatrix/protocol";
import { appOrigins } from "./deployment-origins";
import { appendVary } from "./index-shared";
import type { Env } from "./types";

/**
 * Requests the Web app makes straight to the Hub, as it already opens live
 * page sessions and signs in, instead of through its own Worker: a page's
 * text, margin, sections, claims and Automations, a conversation's history,
 * and the ticket a page's live session opens with. Only the app's own origin
 * is answered, with a bearer token and the client identity in headers and
 * never a cookie, so this widens no access: each route still authorizes the
 * bearer exactly as it does through the Web.
 */
const DIRECT_ROUTES: ReadonlyArray<{ method: "GET" | "POST"; path: RegExp }> = [
  { method: "GET", path: /^\/api\/spaces\/[^/]+\/pages$/u },
  { method: "GET", path: /^\/api\/spaces\/[^/]+\/pages\/recent-changes$/u },
  { method: "GET", path: /^\/api\/spaces\/[^/]+\/pages\/[^/]+$/u },
  { method: "GET", path: /^\/api\/spaces\/[^/]+\/pages\/[^/]+\/(?:awareness|blame|claims|automations|suggestions|read)$/u },
  { method: "GET", path: /^\/api\/spaces\/[^/]+\/pages\/[^/]+\/revisions\/[0-9]+\/moment$/u },
  { method: "GET", path: /^\/api\/spaces\/[^/]+\/page-links(?:\/agents)?$/u },
  { method: "GET", path: /^\/api\/spaces\/[^/]+\/faces$/u },
  { method: "GET", path: /^\/api\/channels\/[^/]+\/history$/u },
  // A ticket names no more than the bearer's own access, and lapses unused within a minute.
  { method: "POST", path: /^\/api\/spaces\/[^/]+\/pages\/[^/]+\/live$/u },
];

/** A browser may keep the answer to a preflight this long; Chrome keeps it two hours at most. */
const PREFLIGHT_MAX_AGE_SECONDS = 7200;

const ALLOWED_HEADERS = ["authorization", "content-type", ...Object.values(CLIENT_COMPATIBILITY_HEADERS)].join(", ");

/** The app's origin and the route's method when `request` is one of its direct requests or their preflight. */
function directRequest(request: Request, env: Env): { origin: string; method: string } | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const method = request.method === "OPTIONS" ? request.headers.get("access-control-request-method") : request.method;
  let allowed: string[];
  try {
    allowed = appOrigins(env);
  } catch {
    return null;
  }
  if (!allowed.includes(origin)) return null;
  const pathname = new URL(request.url).pathname;
  const route = DIRECT_ROUTES.find((item) => item.method === method && item.path.test(pathname));
  return route ? { origin, method: route.method } : null;
}

/** Answers the app's direct requests across origins; registered before every route, the preflight included. */
export function registerDirectReadCors(app: Hono<{ Bindings: Env }>): void {
  app.use("/api/*", async (context, next) => {
    const direct = directRequest(context.req.raw, context.env);
    if (!direct) return next();
    const { origin } = direct;
    if (context.req.method === "OPTIONS") {
      const headers = new Headers({
        "access-control-allow-origin": origin,
        "access-control-allow-methods": direct.method,
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
    // The app asks with the browser's default cache mode, which keeps the preflight's answer (a mode that skips
    // the cache makes Chrome repeat the preflight for every request): no direct answer may be kept instead.
    if (!response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");
    context.res = response;
  });
}
