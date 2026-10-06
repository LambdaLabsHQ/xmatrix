import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  CLIENT_COMPATIBILITY_POLICY,
  clientCompatibilityHeaders,
  evaluateClientCompatibility,
  withRoute,
} from "@xmatrix/protocol";
import { getXMatrixHubUrl } from "@/lib/xmatrix";
import {
  requestAuthorizationNeedsRefresh,
  resolveProxyAuthorization,
} from "@/lib/xmatrix-proxy-auth";
import { jwtExpiresAtSeconds } from "@/lib/auth-session-policy";
import {
  NATIVE_ACCESS_COOKIE,
  NATIVE_REFRESH_COOKIE,
  TransientNativeSessionRefreshError,
  clearNativeSessionCookies,
  refreshNativeSession,
  setNativeSessionCookies,
} from "@/lib/native-session";
import {
  APP_COMPATIBILITY_COOKIE,
  appCompatibilityRequiredForProxyRoute,
  parseAppCompatibilityCookie,
} from "@/lib/client-compatibility-server";
import {
  ProxySessionRefreshError,
  classifyProxyFailure,
  logProxyFailure,
} from "@/lib/xmatrix-proxy-failure";

const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;

type ProxyMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function proxyXMatrixRequest(input: {
  route: string;
  method: ProxyMethod;
  authorization?: string;
  headers?: HeadersInit;
  /** A binary body (an avatar upload) carries its own content-type in `headers`. */
  body?: string | ArrayBuffer;
  /** Forward the upstream body as it arrives instead of buffering the full response. */
  streamResponse?: boolean;
  /** Extra response headers to forward from Hub (default: standard media/proxy set). */
  responseHeaders?: readonly string[];
}): Promise<NextResponse> {
  if (input.body && byteLength(input.body) > MAX_PROXY_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body exceeds ${MAX_PROXY_BODY_BYTES} bytes` },
      { status: 413 }
    );
  }

  const clientCompatibility = await getProxyClientCompatibility();
  if (appCompatibilityRequiredForProxyRoute(input.route) && !clientCompatibility) {
    return NextResponse.json(evaluateClientCompatibility({
      component: "app",
      version: "missing",
      protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion,
    }), { status: 426, headers: { "cache-control": "private, no-store" } });
  }

  const controller = new AbortController();
  // Product media and other large proxy downloads can exceed 15s on cold paths.
  const timeout = setTimeout(() => controller.abort(), 60_000);

  const startedAt = Date.now();
  try {
    const authorization = await getProxyAuthorization(input.authorization)
      .catch((cause) => { throw new ProxySessionRefreshError(cause); });
    const response = await fetch(withRoute(getXMatrixHubUrl(), input.route), {
      method: input.method,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(clientCompatibility ? clientCompatibilityHeaders(clientCompatibility) : {}),
        ...(typeof input.body === "string" ? { "content-type": "application/json" } : {}),
        ...input.headers,
      },
      body: input.body,
      cache: "no-store",
      signal: controller.signal,
    });

    // Streaming is opt-in because some callers may rely on the historical
    // fully-buffered proxy behavior. Channel history opts in so the Hub→Web
    // and Web→browser transfers overlap instead of running serially.
    const body = input.streamResponse ? response.body : await response.arrayBuffer();
    const forwardNames = input.responseHeaders ?? [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
      "content-disposition",
      "cache-control",
    ];
    const headers: Record<string, string> = {
      "content-type": response.headers.get("content-type") || "application/json",
      "cache-control": response.headers.get("cache-control") || "no-store",
    };
    for (const name of forwardNames) {
      if (name === "content-type" || name === "cache-control") continue;
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    return new NextResponse(body, {
      status: response.status,
      headers,
    });
  } catch (cause) {
    const failure = classifyProxyFailure({ cause, timedOut: controller.signal.aborted });
    logProxyFailure({
      route: input.route,
      method: input.method,
      elapsedMs: Date.now() - startedAt,
      failure,
      cause,
    });
    return NextResponse.json(
      { error: failure.error, reason: failure.reason },
      { status: failure.status }
    );
  } finally {
    clearTimeout(timeout);
  }
}

type ForwardOptions = {
  body?: boolean;
  streamResponse?: boolean;
  responseHeaders?: readonly string[];
};

/**
 * Forwards an incoming request to one Hub route under the caller's
 * authorization. POST, PUT and PATCH carry the request body unless `body`
 * says otherwise; GET and DELETE carry it only when `body` asks for it.
 */
export async function forwardXMatrixRequest(request: Request, input: {
  route: string;
  method: ProxyMethod;
} & ForwardOptions): Promise<NextResponse> {
  const { body = input.method === "POST" || input.method === "PUT" || input.method === "PATCH", ...proxy } = input;
  return proxyXMatrixRequest({
    ...proxy,
    authorization: request.headers.get("authorization") || undefined,
    ...(body ? { body: await request.text() } : {}),
  });
}

/**
 * A route handler that forwards each request to a Hub route: a fixed path, or
 * a builder that takes the named route params in order.
 */
export function hubRouteHandler<const Segments extends readonly string[] = []>(
  method: ProxyMethod,
  route: string | ((...values: { [I in keyof Segments]: string }) => string),
  segments: Segments = [] as unknown as Segments,
  options: ForwardOptions = {},
) {
  return hubRouteHandlerFrom<Record<Segments[number], string>>(method, (params) => typeof route === "string"
    ? route
    : route(...(segments.map((name: Segments[number]) => params[name]) as { [I in keyof Segments]: string })), options);
}

/** A route handler that forwards each request to the Hub route `resolve` derives from its params and URL. */
export function hubRouteHandlerFrom<Params extends object = Record<string, never>>(
  method: ProxyMethod,
  resolve: (params: Params, url: URL) => string,
  options: ForwardOptions = {},
) {
  return async (request: Request, context: { params: Promise<Params> }) => {
    // Next passes no params to a route without dynamic segments.
    const params = (await context?.params) ?? ({} as Params);
    return forwardXMatrixRequest(request, { ...options, method, route: resolve(params, new URL(request.url)) });
  };
}

/**
 * Handlers for a Space's optional catch-all route: `build` receives the
 * remaining segments, each encoded, as one subpath; `search` carries the query
 * along. A route exports the methods it serves.
 */
export function spaceSubpathHandlers(
  build: (spaceId: string, subpath: string) => string,
  { search = false }: { search?: boolean } = {},
) {
  const route = ({ spaceId, path = [] }: { spaceId: string; path?: string[] }, url: URL) => {
    const subpath = path.map((segment) => encodeURIComponent(segment)).join("/");
    return `${build(spaceId, subpath)}${search ? url.search : ""}`;
  };
  return {
    GET: hubRouteHandlerFrom("GET", route),
    POST: hubRouteHandlerFrom("POST", route),
    PUT: hubRouteHandlerFrom("PUT", route),
    PATCH: hubRouteHandlerFrom("PATCH", route),
    DELETE: hubRouteHandlerFrom("DELETE", route),
  };
}

/** `route` carrying `params` as its query, or bare when there are none. */
export function withSearchParams(route: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

/** Each named query param whose first value is non-empty, in `names` order. */
export function pickSearchParams(source: URLSearchParams, names: readonly string[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of names) {
    const value = source.get(name);
    if (value) params.set(name, value);
  }
  return params;
}

async function getProxyClientCompatibility() {
  const cookieStore = await cookies();
  return parseAppCompatibilityCookie(cookieStore.get(APP_COMPATIBILITY_COOKIE)?.value);
}

function byteLength(value: string | ArrayBuffer) {
  return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
}

export async function getProxyAuthorization(requestAuthorization?: string): Promise<string | undefined> {
  const explicitAuthorization = requestAuthorization?.trim();
  if (explicitAuthorization && !requestAuthorizationNeedsRefresh(explicitAuthorization)) {
    return explicitAuthorization;
  }

  const cookieAuthorization = await getCookieAuthorization();
  return resolveProxyAuthorization({
    requestAuthorization: explicitAuthorization,
    cookieAuthorization,
  });
}

async function getCookieAuthorization(): Promise<string | undefined> {
  const nativeAuthorization = await getNativeSessionCookieAuthorization();
  if (nativeAuthorization) return nativeAuthorization;

  const betterAuthAuthorization = await getBetterAuthCookieAuthorization();
  if (betterAuthAuthorization) return betterAuthAuthorization;

  // Mock-auth builds (local stack, browser e2e) have no session cookie; the
  // signed-in mock user is the build's own token. Production never sets it.
  const mockToken = process.env.NEXT_PUBLIC_XMATRIX_MOCK_AUTH_TOKEN?.trim();
  if (mockToken) return `Bearer ${mockToken}`;

  return undefined;
}

async function getNativeSessionCookieAuthorization(): Promise<string | undefined> {
  const cookieStore = await cookies();
  const token = cookieStore.get(NATIVE_ACCESS_COOKIE)?.value?.trim();
  const refreshToken = cookieStore.get(NATIVE_REFRESH_COOKIE)?.value?.trim();
  if (token && !accessTokenNeedsRefresh(token)) {
    return `Bearer ${token}`;
  }
  if (!refreshToken) {
    if (token) clearNativeSessionCookies(cookieStore);
    return undefined;
  }

  const refreshed = await refreshNativeSession(refreshToken).catch((error) => {
    if (error instanceof TransientNativeSessionRefreshError) {
      return "transient" as const;
    }
    throw error;
  });
  if (refreshed === "transient") {
    return token ? `Bearer ${token}` : undefined;
  }
  if (!refreshed) {
    clearNativeSessionCookies(cookieStore);
    return undefined;
  }

  setNativeSessionCookies(cookieStore, refreshed);
  return `Bearer ${refreshed.token}`;
}

async function getBetterAuthCookieAuthorization(): Promise<string | undefined> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  if (!cookieHeader) return undefined;

  const response = await fetch(withRoute(getXMatrixHubUrl(), "/api/auth/token"), {
    headers: {
      cookie: cookieHeader,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json().catch(() => ({}))) as { token?: string };
  const token = payload.token?.trim();
  return token ? `Bearer ${token}` : undefined;
}
// Refresh only when the access token is missing or within this margin of
// expiry, so each active session refreshes roughly once per token lifetime
// instead of once per request.
const REFRESH_MARGIN_SECONDS = 5 * 60;

function accessTokenNeedsRefresh(token: string): boolean {
  const expiresAt = jwtExpiresAtSeconds(token);
  if (!expiresAt) return false;
  const secondsUntilExpiry = expiresAt - Math.floor(Date.now() / 1000);
  return secondsUntilExpiry < REFRESH_MARGIN_SECONDS;
}
