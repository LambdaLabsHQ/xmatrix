import { readBoundedStream, stripHtmlTags } from "@xmatrix/protocol";
import { appStoreConnect, appleApp, BUNDLE_ID, type AppleResource, type AppStoreConnectApi } from "./app-store-connect-api";
import { cell } from "./actions/google-report";
import { record, text } from "./event-format";
import { ConnectorRemedy, ProviderRequestError } from "./http";
import type { ConnectorAction, ConnectorActionContext, ConnectorActionResult, ConnectorActionStatement } from "./provider";

/*
 * App Review's messages: the rejection reasons and the reviewer's own words.
 * Apple's public API has no resource for them (specification 4.5.1); the App
 * Store Connect website reads them from its own `iris` endpoints, which take
 * the signed-in web session rather than an API key.
 *
 * The connection keeps that session as one encrypted credential, the Cookie
 * header of a signed-in appstoreconnect.apple.com page, and every request goes
 * from the Hub with it, so no machine has to stay on. The desktop app fills it
 * by signing in on Apple's own page in a window of its own; elsewhere it is
 * pasted. Apple rotates some of the cookies as they are used; the rotated
 * values are saved back into the same credential. The Apple ID password never
 * reaches xMatrix. Apple keeps a session from a day to a month, shorter when
 * it is used from another region than it was signed in from, and signing in
 * again is the only renewal.
 *
 * Only Apple's own origin, no redirects followed: a redirect is Apple asking
 * for a new sign-in. What reviewers wrote is untrusted text. The same session
 * also does what the website alone can: create an app record and answer App
 * Privacy (app-store-connect-web-records.ts). Writes are sent once and never
 * retried.
 */

const ORIGIN = "https://appstoreconnect.apple.com";
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const RENEW = { kind: "credential", field: "webSession" } as const;
const EXPIRED = "The App Store Connect web session is missing or has expired; sign in again under Apps → App Store Connect → Credentials (Sign in to App Store Connect in the xMatrix app)";

/** `name=value; name=value`, as copied from a request's Cookie header, into an ordered map. */
export function parseCookies(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.replace(/^\s*cookie:\s*/iu, "").split(";")) {
    const index = part.indexOf("=");
    const name = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    if (index > 0 && COOKIE_NAME.test(name) && !/[\s;,\\]/u.test(value) && value.length <= 4_096) cookies.set(name, value);
  }
  return cookies;
}

const cookieHeader = (cookies: Map<string, string>) => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");

/** The Set-Cookie lines of a response, by whichever accessor the runtime offers. */
function setCookies(headers: Headers): string[] {
  const reader = headers as Headers & { getSetCookie?: () => string[]; getAll?: (name: string) => string[] };
  if (typeof reader.getSetCookie === "function") return reader.getSetCookie();
  if (typeof reader.getAll === "function") return reader.getAll("set-cookie");
  return headers.get("set-cookie") ? [headers.get("set-cookie")!] : [];
}

/** Apply Apple's rotated cookies; an expired or emptied one is dropped. Answers whether anything changed. */
export function applySetCookies(cookies: Map<string, string>, lines: string[], now = Date.now()): boolean {
  let changed = false;
  for (const line of lines) {
    const [pair = "", ...attributes] = line.split(";");
    const index = pair.indexOf("=");
    const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
    if (index <= 0 || !COOKIE_NAME.test(name) || /[\s,\\]/u.test(value)) continue;
    const gone = !value || attributes.some(attribute => {
      const [key = "", setting = ""] = attribute.split("=").map(piece => piece.trim());
      return (/^max-age$/iu.test(key) && Number(setting) <= 0) || (/^expires$/iu.test(key) && Date.parse(setting) <= now);
    });
    if (gone) changed = cookies.delete(name) || changed;
    else if (cookies.get(name) !== value) { cookies.set(name, value); changed = true; }
  }
  return changed;
}

/** Apple's own words for a refusal, from a JSON:API error document. */
function websiteProblem(payload: unknown): string | undefined {
  const errors = (Array.isArray(record(payload).errors) ? record(payload).errors as unknown[] : []).map(record);
  const lines = [...new Set(errors.map(error => text(error.detail) || text(error.title) || text(error.code)).filter(Boolean))];
  return lines.length ? lines.join("; ").replace(/\s+/gu, " ").slice(0, 600) : undefined;
}

/** One web session for the duration of an action; rotated cookies are saved once at its end. */
export function webSession(context: Pick<ConnectorActionContext, "credentials" | "saveCredentials" | "authorizeWrite">) {
  const cookies = parseCookies(context.credentials.webSession ?? "");
  let changed = false;
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, query: Record<string, string>,
    body?: Record<string, unknown>, quiet = false): Promise<Record<string, unknown>> => {
    if (!cookies.size) throw new ConnectorRemedy(401, EXPIRED, RENEW);
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || !/^\/(iris\/v1|olympus\/v1|WebObjects\/iTunesConnect\.woa\/ra\/paymentConsolidation)\//u.test(url.pathname)) throw new ProviderRequestError(502, "App Store Connect returned a link outside its website API");
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    if (method !== "GET") await context.authorizeWrite?.();
    // The website's own client marks its iris calls with this header; Apple refuses some without it.
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(url, { method, redirect: "manual", signal, headers: { cookie: cookieHeader(cookies),
      accept: "application/json", "x-requested-with": "XMLHttpRequest", "x-csrf-itc": "[asc-ui]", origin: ORIGIN, referer: `${ORIGIN}/`,
      "user-agent": "xMatrix-Connectors", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    changed = applySetCookies(cookies, setCookies(response.headers)) || changed;
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new ConnectorRemedy(401, EXPIRED, RENEW);
    }
    let bytes: Uint8Array;
    try { bytes = await readBoundedStream(response.body, MAX_BYTES, () => new Error("response exceeds size limit"), signal); }
    catch { throw new ProviderRequestError(502, "App Store Connect's answer could not be read within its size limit"); }
    if (response.status === 204 || (response.ok && !bytes.byteLength && method !== "GET")) return {};
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { payload = undefined; }
    // A refusal with Apple's reasons is about the request; a bare 403 is the session.
    const problem = response.ok ? undefined : websiteProblem(payload);
    if (response.status === 403 && !problem) throw new ConnectorRemedy(401, EXPIRED, RENEW);
    if (!response.ok || !payload || typeof payload !== "object") {
      throw new ProviderRequestError(response.ok ? 502 : response.status, response.ok ? "App Store Connect did not answer with JSON; the website may have changed"
        : `App Store Connect's website returned ${response.status}${problem && !quiet ? `: ${problem}` : ""}`);
    }
    return payload as Record<string, unknown>;
  };
  return {
    read: (path: string, query: Record<string, string> = {}) => call("GET", path, query),
    /** A change, sent once: nothing here retries a write. */
    send: (method: "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>) => call(method, path, {}, body),
    /** A credential-bearing request: provider error text may echo private fields, so never include it in a receipt. */
    sendPrivate: (method: "POST" | "PATCH" | "DELETE", path: string, body: Record<string, unknown>) => call(method, path, {}, body, true),
    /** Save the rotated cookies, if any; a failed save must not hide what was read. */
    async settle(): Promise<void> {
      if (changed && cookies.size && context.saveCredentials) await context.saveCredentials({ webSession: cookieHeader(cookies) }).catch(() => undefined);
    },
  };
}

export type WebSession = ReturnType<typeof webSession>;

const NAME_APP = "name an app by its bundle ID: <com.example.app>";
/** A bundle ID and nothing else. */
export const appOnly = (statement: ConnectorActionStatement) => BUNDLE_ID.test(statement.target) && !statement.text.trim() ? { app: statement.target } : NAME_APP;

/** An action about one app: the API key finds it, the web session does the rest, and rotated cookies are saved at the end. */
export function appWebAction(effect: "read" | "write", parse: ConnectorAction["parse"],
  run: (session: WebSession, app: AppleResource, input: Record<string, string>, api: AppStoreConnectApi) => Promise<ConnectorActionResult>): ConnectorAction {
  return {
    effect, requires: ["webSession", "keyId", "privateKey"], parse,
    async execute(context, input) {
      const api = appStoreConnect(context.credentials), app = await appleApp(api, input.app!);
      const session = webSession(context);
      try { return await run(session, app, input, api); } finally { await session.settle(); }
    },
  };
}

/** The plain text of a message Apple stores as HTML. */
export function plainText(html: string): string {
  return stripHtmlTags(html.replace(/<(br|\/p|\/div|\/li)\b[^>]*>/giu, "\n"), " ")
    .replace(/&nbsp;/gu, " ").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/&#39;|&apos;/gu, "'").replace(/&amp;/gu, "&")
    .split("\n").map(line => line.replace(/\s+/gu, " ").trim()).filter(Boolean).join("\n");
}

export const APP_STORE_CONNECT_WEB_ACTIONS: Record<string, ConnectorAction> = {
  web_session: {
    effect: "read", requires: ["webSession"],
    parse: statement => statement.target === "*" && !statement.text.trim() ? {} : "use @appstoreconnect:web_session:*",
    async execute(context) {
      const session = webSession(context);
      try {
        const info = await session.read("/olympus/v1/session");
        const user = record(info.user), provider = record(info.provider);
        return { summary: `The App Store Connect web session works: signed in as ${cell(user.fullName) || "an Apple ID"}, team ${cell(provider.name) || "?"}. ` +
          "Apple keeps it a day to a month; when it lapses, review_messages says so." };
      } finally { await session.settle(); }
    },
  },
};
