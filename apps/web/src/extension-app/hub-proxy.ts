/**
 * The Web's Hub proxy (src/lib/xmatrix-proxy.ts) for the app bundled into the
 * Chrome extension. The Web's proxy routes (src/app/api/xmatrix) are bundled as
 * they are and run in the page (local-api.ts); this module takes the place of
 * the Worker's hop for them, so each still names the same Hub route with the
 * same query and headers, and the request goes to the Hub straight from the
 * extension. The bundle resolves `@/lib/xmatrix-proxy` here.
 *
 * Authorization is the caller's bearer, or the extension's current access
 * token when a call carries none (the Web reads its session cookie there).
 * The Hub authorizes every call exactly as it does through the Web.
 */
import { withRoute } from "@xmatrix/protocol";
import { embedClientCompatibilityHeaders, extensionAskToken, extensionEmbedParent, requestEmbedSession } from "@/lib/extension-embed";
import { getXMatrixHubUrl } from "@/lib/xmatrix";
import {
  createHubRouteHandlers,
  pickSearchParams,
  withSearchParams,
  type HubProxyRequest,
} from "@/lib/xmatrix-proxy-handlers";

export { pickSearchParams, withSearchParams };

/** The extension's token for a call that carries none; asked for once per burst of such calls. */
let pendingToken: Promise<string | null> | null = null;
function extensionToken(): Promise<string | null> {
  const parent = extensionEmbedParent();
  if (!parent) return Promise.resolve(extensionAskToken());
  pendingToken ??= requestEmbedSession(parent)
    .then((session) => session?.token ?? null)
    .finally(() => { pendingToken = null; });
  return pendingToken;
}

export async function getProxyAuthorization(requestAuthorization?: string): Promise<string | undefined> {
  const explicit = requestAuthorization?.trim();
  if (explicit) return explicit;
  const token = await extensionToken();
  return token ? `Bearer ${token}` : undefined;
}

export async function proxyXMatrixRequest(input: HubProxyRequest): Promise<Response> {
  const authorization = await getProxyAuthorization(input.authorization);
  const headers = new Headers(input.headers);
  if (authorization) headers.set("authorization", authorization);
  if (typeof input.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  for (const [name, value] of Object.entries(embedClientCompatibilityHeaders())) headers.set(name, value);
  return fetch(withRoute(getXMatrixHubUrl(), input.route), {
    method: input.method,
    headers,
    body: input.body,
    credentials: "omit",
    cache: "no-store",
    signal: input.signal,
  });
}

export const {
  forwardXMatrixRequest,
  hubRouteHandler,
  hubRouteHandlerFrom,
  spaceSubpathHandlers,
} = createHubRouteHandlers(proxyXMatrixRequest);
