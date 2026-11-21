/**
 * The Web's proxy route handlers, apart from the hop that carries them. The
 * routes under src/app/api/xmatrix name a Hub route for each Web route; what
 * sends the request on is the Worker's hop (xmatrix-proxy.ts) on the Web, and
 * the page's own hop (extension-app/hub-proxy.ts) in the app bundled into the
 * Chrome extension, which runs the same routes in the page.
 */
export type ProxyMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type HubProxyRequest = {
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
  /** The caller's own abort, for a hop that can follow it. */
  signal?: AbortSignal;
};

export type ForwardOptions = {
  body?: boolean;
  /** Request headers the Hub route reads, carried from the browser's request. */
  requestHeaders?: readonly string[];
  streamResponse?: boolean;
  responseHeaders?: readonly string[];
};

/** The route handlers that send each request on through `proxy`. */
export function createHubRouteHandlers<Answer extends Response>(proxy: (input: HubProxyRequest) => Promise<Answer>) {
  /**
   * Forwards an incoming request to one Hub route under the caller's
   * authorization. POST, PUT and PATCH carry the request body unless `body`
   * says otherwise; GET and DELETE carry it only when `body` asks for it.
   */
  async function forwardXMatrixRequest(request: Request, input: {
    route: string;
    method: ProxyMethod;
  } & ForwardOptions): Promise<Answer> {
    const { body = input.method === "POST" || input.method === "PUT" || input.method === "PATCH", requestHeaders = [],
      ...rest } = input;
    const headers: Record<string, string> = {};
    for (const name of requestHeaders) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    return proxy({
      ...rest,
      headers,
      authorization: request.headers.get("authorization") || undefined,
      signal: request.signal,
      ...(body ? { body: await request.text() } : {}),
    });
  }

  /** A route handler that forwards each request to the Hub route `resolve` derives from its params and URL. */
  function hubRouteHandlerFrom<Params extends object = Record<string, never>>(
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
   * A route handler that forwards each request to a Hub route: a fixed path, or
   * a builder that takes the named route params in order.
   */
  function hubRouteHandler<const Segments extends readonly string[] = []>(
    method: ProxyMethod,
    route: string | ((...values: { [I in keyof Segments]: string }) => string),
    segments: Segments = [] as unknown as Segments,
    options: ForwardOptions = {},
  ) {
    return hubRouteHandlerFrom<Record<Segments[number], string>>(method, (params) => typeof route === "string"
      ? route
      : route(...(segments.map((name: Segments[number]) => params[name]) as { [I in keyof Segments]: string })), options);
  }

  /**
   * Handlers for a Space's optional catch-all route: `build` receives the
   * remaining segments, each encoded, as one subpath; `search` carries the query
   * along, and `get` how its reads are forwarded. A route exports the methods it serves.
   */
  function spaceSubpathHandlers(
    build: (spaceId: string, subpath: string) => string,
    { search = false, get }: { search?: boolean; get?: ForwardOptions } = {},
  ) {
    const route = ({ spaceId, path = [] }: { spaceId: string; path?: string[] }, url: URL) => {
      const subpath = path.map((segment) => encodeURIComponent(segment)).join("/");
      return `${build(spaceId, subpath)}${search ? url.search : ""}`;
    };
    return {
      GET: hubRouteHandlerFrom("GET", route, get),
      POST: hubRouteHandlerFrom("POST", route),
      PUT: hubRouteHandlerFrom("PUT", route),
      PATCH: hubRouteHandlerFrom("PATCH", route),
      DELETE: hubRouteHandlerFrom("DELETE", route),
    };
  }

  return { forwardXMatrixRequest, hubRouteHandler, hubRouteHandlerFrom, spaceSubpathHandlers };
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
