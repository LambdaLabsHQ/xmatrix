/**
 * The Web's `/api` in the page, for the app bundled into the Chrome extension.
 *
 * On the Web a request to `/api/xmatrix/...` reaches a Next route that names a
 * Hub route and sends it on. Here the same route modules are bundled
 * (the build lists them in `api-routes`) and answer in the page: `fetch` to
 * this origin's `/api` is matched to its route as Next matches it, and the
 * route's handler sends the request to the Hub (hub-proxy.ts). Nothing else
 * about `fetch` changes.
 */
import { CLIENT_COMPATIBILITY_PATH, clientCompatibilityHeaders, parseClientCompatibilityIdentity } from "@xmatrix/protocol";
import { getXMatrixHubUrl } from "@/lib/xmatrix";

type RouteHandler = (request: Request, context: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;
export type RouteModule = Partial<Record<string, RouteHandler | unknown>>;
/** A Next route's path under the app directory's `api`, e.g. `xmatrix/channels/[channelId]/history`. */
export type ApiRoute = readonly [path: string, module: RouteModule];

type Segment = { kind: "static"; value: string } | { kind: "param" | "rest" | "optional-rest"; name: string };
type CompiledRoute = { segments: Segment[]; module: RouteModule };

function compile([path, module]: ApiRoute): CompiledRoute {
  const segments = path.split("/").filter(Boolean).map((part): Segment => {
    const optionalRest = /^\[\[\.\.\.(.+)\]\]$/u.exec(part);
    if (optionalRest) return { kind: "optional-rest", name: optionalRest[1] };
    const rest = /^\[\.\.\.(.+)\]$/u.exec(part);
    if (rest) return { kind: "rest", name: rest[1] };
    const param = /^\[(.+)\]$/u.exec(part);
    return param ? { kind: "param", name: param[1] } : { kind: "static", value: part };
  });
  return { segments, module };
}

/** Next's order: at each segment a fixed name wins over a parameter, and a parameter over a catch-all. */
const SEGMENT_RANK = { static: 0, param: 1, rest: 2, "optional-rest": 3 } as const;
function bySpecificity(left: CompiledRoute, right: CompiledRoute): number {
  const length = Math.max(left.segments.length, right.segments.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.segments[index], b = right.segments[index];
    if (!a || !b) return a ? 1 : -1;
    if (SEGMENT_RANK[a.kind] !== SEGMENT_RANK[b.kind]) return SEGMENT_RANK[a.kind] - SEGMENT_RANK[b.kind];
  }
  return 0;
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function match(route: CompiledRoute, parts: string[]): Record<string, string | string[]> | null {
  const params: Record<string, string | string[]> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const segment = route.segments[index];
    if (segment.kind === "rest" || segment.kind === "optional-rest") {
      const rest = parts.slice(index).map(decoded);
      if (rest.length === 0 && segment.kind === "rest") return null;
      if (rest.length > 0) params[segment.name] = rest;
      return params;
    }
    const part = parts[index];
    if (part === undefined) return null;
    if (segment.kind === "static") {
      if (segment.value !== part) return null;
    } else params[segment.name] = decoded(part);
  }
  return parts.length === route.segments.length ? params : null;
}

/** What this build is, for the app's stale-build check: never stale, since its files change only with the extension. */
function webBuild(): Response {
  return Response.json({ buildId: process.env.NEXT_PUBLIC_XMATRIX_WEB_BUILD_ID?.trim() || "" });
}

/** The Hub's own word on whether it admits this client; the Web asks the same route for a browser. */
async function clientCompatibility(request: Request, hubFetch: typeof fetch): Promise<Response> {
  const identity = parseClientCompatibilityIdentity(await request.json().catch(() => null));
  if (!identity) return Response.json({ compatible: false, code: "invalid_client_identity" }, { status: 426 });
  return hubFetch(new URL(CLIENT_COMPATIBILITY_PATH, getXMatrixHubUrl()), {
    headers: clientCompatibilityHeaders(identity),
    cache: "no-store",
    credentials: "omit",
    signal: request.signal,
  });
}

function notHere(): Response {
  return Response.json({ error: "This is not available in the xMatrix extension.", code: "not_found" }, { status: 404 });
}

/** Answers `/api` requests from the bundled routes; `hubFetch` is the page's own `fetch`. */
export function createLocalApi(routes: readonly ApiRoute[], hubFetch: typeof fetch) {
  const compiled = routes.map(compile).sort(bySpecificity);
  return async function localApi(request: Request): Promise<Response> {
    const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
    const path = parts.join("/");
    if (path === "web-build") return webBuild();
    if (path === "client-compatibility" || path === "xmatrix/client-compatibility") return clientCompatibility(request, hubFetch);
    // A defect report goes to the Web's own error reporting, which this page has no route to.
    if (path === "client-defects") return Response.json({ reference: null }, { status: 202 });
    for (const route of compiled) {
      const params = match(route, parts);
      if (!params) continue;
      const handler = route.module[request.method];
      if (typeof handler !== "function") return new Response(null, { status: 405 });
      return (handler as RouteHandler)(request, { params: Promise.resolve(params) });
    }
    return notHere();
  };
}

/** Whether `input` asks this page's own `/api`. */
function localApiUrl(input: RequestInfo | URL): boolean {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : input, window.location.href);
  } catch {
    return false;
  }
  return url.origin === window.location.origin && (url.pathname === "/api" || url.pathname.startsWith("/api/"));
}

/** A caller that gives up stops waiting at once, whatever the route was doing. */
function untilAborted(answer: Promise<Response>, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    answer.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Makes this page's `fetch` answer its own `/api` from the bundled routes. */
export function installLocalApi(routes: readonly ApiRoute[]): void {
  const nativeFetch = window.fetch.bind(window);
  const localApi = createLocalApi(routes, nativeFetch);
  window.fetch = (input, init) => {
    if (!localApiUrl(input)) return nativeFetch(input, init);
    let request: Request;
    try {
      request = new Request(input instanceof Request ? input : new URL(input, window.location.href), init);
    } catch (cause) {
      return Promise.reject(cause);
    }
    return untilAborted(localApi(request), request.signal);
  };
}
