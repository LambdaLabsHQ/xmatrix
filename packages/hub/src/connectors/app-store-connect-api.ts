import { pemPrivateKeyBytes } from "../push/apns";
import { base64UrlEncodeValue } from "../relay-v2-primitives";
import { connectorIngressUrl } from "./credentials";
import { oneLine, record, text } from "./event-format";
import { providerJson, ProviderRequestError } from "./http";
import type { ConnectorSubscriptionSync } from "./provider";

/*
 * App Store Connect API for the connector (docs/operations/app-connectors.md).
 * The credential is an API key from Users and Access → Integrations: its Key
 * ID, the team's Issuer ID (none for an individual key) and the `.p8` private
 * key. Every call carries a ten-minute ES256 token signed here; the key never
 * leaves the credential store. Requests go only to Apple's API origin, and a
 * pagination link that points anywhere else is refused.
 *
 * Subscribing a Channel to an app makes that app have one webhook, named for
 * the Space, that posts to this connection's ingress with the connection's
 * secret; the Space's last unsubscribe removes it.
 */

const ORIGIN = "https://api.appstoreconnect.apple.com";
const TOKEN_SECONDS = 600;
const MAX_PAGES = 5;
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_PROBLEM = 900;

export const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/u;
const WEBHOOK_EVENTS = ["APP_STORE_VERSION_APP_VERSION_STATE_UPDATED", "BUILD_UPLOAD_STATE_UPDATED",
  "BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED", "BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED",
  "BETA_FEEDBACK_CRASH_SUBMISSION_CREATED"];
const webhookName = (spaceId: string) => `xMatrix · ${spaceId}`;

type Credentials = Readonly<Record<string, string>>;

export interface AppleResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, unknown>;
}

export interface AppStoreConnectApi {
  /** One JSON:API call; `data` and `included` (resources created inline) become the request's members. A 204 answers `{}`. */
  request(path: string, init?: { method?: "GET" | "POST" | "PATCH" | "DELETE"; query?: Record<string, string>; data?: unknown; included?: unknown[];
    /** Keep Apple's error text out of the receipt: the call carries review contact or sign-in details. */
    quiet?: boolean }): Promise<Record<string, unknown>>;
  /** A collection and what it includes, following Apple's own next links for at most `pages` pages. */
  list(path: string, query?: Record<string, string>, pages?: number): Promise<{ rows: AppleResource[]; included: AppleResource[] }>;
}

export function appleResource(value: unknown): AppleResource | undefined {
  const row = record(value);
  return typeof row.id === "string" && row.id && typeof row.type === "string"
    ? { id: row.id, type: row.type, attributes: record(row.attributes), relationships: record(row.relationships) } : undefined;
}

/** The id a to-one relationship points at, if it points at anything. */
export function relatedId(row: AppleResource, name: string): string | undefined {
  return text(record(record(row.relationships[name]).data).id) || undefined;
}

/** The ids a to-many relationship lists; empty unless the response included it. */
export function relatedIds(row: AppleResource, name: string): string[] {
  const data = record(row.relationships[name]).data;
  return (Array.isArray(data) ? data : []).flatMap((item) => text(record(item).id) || []);
}

export const relation = (type: string, id: string) => ({ data: { type, id } });

/** PKCS#8 bytes from the `.p8` file as pasted: with or without line breaks, or the whole file in base64. */
function privateKeyBytes(value: string): ArrayBuffer {
  let bytes = pemPrivateKeyBytes(value);
  if (new TextDecoder().decode(bytes.slice(0, 10)) === "-----BEGIN") bytes = pemPrivateKeyBytes(new TextDecoder().decode(bytes));
  return bytes;
}

async function bearer(credentials: Credentials, nowSeconds: number): Promise<string> {
  const keyId = credentials.keyId?.trim() ?? "";
  const issuerId = credentials.issuerId?.trim() ?? "";
  if (!/^[A-Z0-9]{8,20}$/u.test(keyId) || !credentials.privateKey || (issuerId && !/^[0-9a-f-]{36}$/iu.test(issuerId))) {
    throw new ProviderRequestError(401, "Save the App Store Connect API key first: Key ID, the .p8 private key, and the Issuer ID for a team key");
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", privateKeyBytes(credentials.privateKey),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new ProviderRequestError(401, "The private key is not a .p8 file from App Store Connect; paste the whole AuthKey file");
  }
  const claims = { iat: nowSeconds - 10, exp: nowSeconds + TOKEN_SECONDS, aud: "appstoreconnect-v1" };
  const unsigned = `${base64UrlEncodeValue(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }))}.${
    base64UrlEncodeValue(JSON.stringify(issuerId ? { iss: issuerId, ...claims } : { sub: "user", ...claims }))}`;
  const signed = new TextEncoder().encode(unsigned);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key,
    signed.buffer.slice(signed.byteOffset, signed.byteOffset + signed.byteLength) as ArrayBuffer);
  return `Bearer ${unsigned}.${base64UrlEncodeValue(signature)}`;
}

/** Apple's `errors`, with the checks a refused submission lists under `meta.associatedErrors`. */
function appleProblem(payload: Record<string, unknown>, quiet: boolean): string | undefined {
  const errors = (Array.isArray(payload.errors) ? payload.errors : []).map(record);
  if (quiet) return errors.map((error) => text(error.code)).filter(Boolean).slice(0, 3).join("; ") || undefined;
  const lines = errors.flatMap((error) => [text(error.detail) || text(error.title) || text(error.code),
    ...Object.values(record(record(error.meta).associatedErrors)).flatMap((list) => Array.isArray(list) ? list : [])
      .map((related) => text(record(related).detail) || text(record(related).title))]).filter(Boolean);
  return lines.length ? oneLine([...new Set(lines)].join("; "), MAX_PROBLEM) : undefined;
}

function apiUrl(path: string, query: Record<string, string> = {}): URL {
  let url: URL;
  try { url = new URL(path, ORIGIN); } catch { throw new ProviderRequestError(502, "App Store Connect returned an invalid link"); }
  if (url.origin !== ORIGIN || !/^\/v[1-9]\//u.test(url.pathname) || url.username || url.password || url.hash) {
    throw new ProviderRequestError(502, "App Store Connect returned a link outside its API");
  }
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

export function appStoreConnect(credentials: Credentials, now: () => number = Date.now): AppStoreConnectApi {
  /* One token serves every call of an action; it outlives the action by minutes at most. */
  let authorization: Promise<string> | undefined;
  const request: AppStoreConnectApi["request"] = async (path, init = {}) => {
    authorization ??= bearer(credentials, Math.floor(now() / 1_000));
    let problem: string | undefined;
    try {
      return await providerJson(apiUrl(path, init.query), { method: init.method ?? "GET", maxBytes: MAX_LIST_BYTES,
        headers: { authorization: await authorization },
        ...(init.data === undefined ? {} : { json: { data: init.data, ...(init.included ? { included: init.included } : {}) } }),
        describeError: (payload) => problem = appleProblem(payload, init.quiet === true) });
    } catch (error) {
      if (!(error instanceof ProviderRequestError)) throw error;
      const hint = error.status === 401 ? " (check the Issuer ID, Key ID and private key, and that the key is still active)"
        : error.status === 403 ? " (the API key's role does not allow this)" : "";
      throw new ProviderRequestError(error.status, problem
        ? `App Store Connect returned ${error.status}: ${problem}${hint}` : `${error.message}${hint}`);
    }
  };
  return {
    request,
    async list(path, query = {}, pages = MAX_PAGES) {
      const rows: AppleResource[] = [], included: AppleResource[] = [];
      let next: string | undefined = apiUrl(path, query).toString();
      for (let page = 0; next && page < Math.min(pages, MAX_PAGES); page += 1) {
        const response = await request(next);
        if (!Array.isArray(response.data)) throw new ProviderRequestError(502, "App Store Connect did not return a list");
        rows.push(...response.data.flatMap((row) => appleResource(row) ?? []));
        included.push(...(Array.isArray(response.included) ? response.included : []).flatMap((row) => appleResource(row) ?? []));
        next = text(record(response.links).next) || undefined;
      }
      return { rows, included };
    },
  };
}

/**
 * The one app with this bundle ID that the key can see. Bundle IDs compare
 * without case: a Channel's source is lower case, and Apple's own filter may
 * not be, so a miss is retried against the key's whole app list.
 */
export async function appleApp(api: AppStoreConnectApi, bundleId: string): Promise<AppleResource> {
  const query = { "fields[apps]": "name,bundleId,sku,primaryLocale,contentRightsDeclaration", limit: "200" };
  const named = (rows: AppleResource[]) => rows.filter((app) => text(app.attributes.bundleId).toLowerCase() === bundleId.toLowerCase());
  let apps = named((await api.list("/v1/apps", { ...query, "filter[bundleId]": bundleId })).rows);
  if (!apps.length) apps = named((await api.list("/v1/apps", query)).rows);
  if (apps.length !== 1) {
    throw new ProviderRequestError(404, `${bundleId} is not an app this API key can see; create the app record in App Store Connect first`);
  }
  return apps[0]!;
}

/** Check: the key signs a token Apple accepts. No app is needed yet. */
export async function verifyAppStoreConnect(credentials: Credentials): Promise<void> {
  const response = await appStoreConnect(credentials).request("/v1/apps", { query: { "fields[apps]": "bundleId", limit: "1" } });
  if (!Array.isArray(response.data)) throw new ProviderRequestError(502, "App Store Connect did not return an app list");
}

export const APP_STORE_CONNECT_SUBSCRIPTIONS: ConnectorSubscriptionSync = {
  async sync({ env, spaceId, credentials, source, subscribed }) {
    /* `*` routes webhooks the team configured itself; it registers nothing. */
    if (source === "*") return undefined;
    const origin = env.HUB_URL?.trim();
    if (!origin || !credentials.ingressKey) throw new ProviderRequestError(503, "App Store Connect ingress is not configured");
    const api = appStoreConnect(credentials);
    const app = await appleApp(api, source);
    const hooks = (await api.list(`/v1/apps/${encodeURIComponent(app.id)}/webhooks`,
      { "fields[webhooks]": "enabled,eventTypes,name,url", limit: "50" })).rows.filter((hook) => text(hook.attributes.name) === webhookName(spaceId));
    const remove = (hook: AppleResource) => api.request(`/v1/webhooks/${encodeURIComponent(hook.id)}`, { method: "DELETE" });
    if (!subscribed) {
      for (const hook of hooks) await remove(hook);
      return undefined;
    }
    if (!credentials.webhookSecret) throw new ProviderRequestError(409, "The connection has no webhook secret; save its credentials again");
    /* The app rides in the URL: Apple's payload names a version or a build, never the app. */
    const url = new URL(connectorIngressUrl(origin, "appstoreconnect", spaceId, credentials.ingressKey));
    url.searchParams.set("app", text(app.attributes.bundleId).toLowerCase());
    if (/^\d{1,20}$/u.test(app.id)) url.searchParams.set("id", app.id);
    const attributes = { enabled: true, eventTypes: WEBHOOK_EVENTS, name: webhookName(spaceId), secret: credentials.webhookSecret, url: url.toString() };
    const [current, ...duplicates] = hooks;
    for (const hook of duplicates) await remove(hook);
    /* An existing webhook takes the current URL and secret, so a regenerated secret heals on the next subscribe. */
    if (current) await api.request(`/v1/webhooks/${encodeURIComponent(current.id)}`, { method: "PATCH", data: { type: "webhooks", id: current.id, attributes } });
    else await api.request("/v1/webhooks", { method: "POST", data: { type: "webhooks", attributes, relationships: { app: relation("apps", app.id) } } });
    return undefined;
  },
};
