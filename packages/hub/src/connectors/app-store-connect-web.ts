import { appStoreConnect, appleApp, appleResource, BUNDLE_ID, relatedId, type AppleResource } from "./app-store-connect-api";
import { quoteRetrievedText } from "./actions/common";
import { cell } from "./actions/google-report";
import { record, text } from "./event-format";
import { ProviderRequestError } from "./http";
import type { ConnectorAction, ConnectorActionContext } from "./provider";

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
const MAX_OUTPUT = 12_000;
const MAX_MESSAGE = 3_000;
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const THREAD_TYPES = "REJECTION_BINARY,REJECTION_METADATA,REJECTION_REVIEW_SUBMISSION,APP_MESSAGE_ARC,APP_MESSAGE_ARB,APP_MESSAGE_COMM,APP_MESSAGE_INFORMATIONAL";
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
export function webSession(context: Pick<ConnectorActionContext, "credentials" | "saveCredentials">) {
  const cookies = parseCookies(context.credentials.webSession ?? "");
  let changed = false;
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, query: Record<string, string>,
    body?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!cookies.size) throw new ProviderRequestError(401, EXPIRED);
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !/^\/(iris\/v1|olympus\/v1)\//u.test(url.pathname)) throw new ProviderRequestError(502, "App Store Connect returned a link outside its website API");
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    // The website's own client marks its iris calls with this header; Apple refuses some without it.
    const response = await fetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { cookie: cookieHeader(cookies),
      accept: "application/json", "x-requested-with": "XMLHttpRequest", "x-csrf-itc": "[asc-ui]", origin: ORIGIN, referer: `${ORIGIN}/`,
      "user-agent": "xMatrix-Connectors", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    changed = applySetCookies(cookies, setCookies(response.headers)) || changed;
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new ProviderRequestError(401, EXPIRED);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) throw new ProviderRequestError(502, "App Store Connect's answer is too large");
    if (response.status === 204 || (response.ok && !bytes.byteLength && method !== "GET")) return {};
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { payload = undefined; }
    // A refusal with Apple's reasons is about the request; a bare 403 is the session.
    const problem = response.ok ? undefined : websiteProblem(payload);
    if (response.status === 403 && !problem) throw new ProviderRequestError(401, EXPIRED);
    if (!response.ok || !payload || typeof payload !== "object") {
      throw new ProviderRequestError(response.ok ? 502 : response.status, response.ok ? "App Store Connect did not answer with JSON; the website may have changed"
        : `App Store Connect's website returned ${response.status}${problem ? `: ${problem}` : ""}`);
    }
    return payload as Record<string, unknown>;
  };
  return {
    read: (path: string, query: Record<string, string> = {}) => call("GET", path, query),
    /** A change, sent once: nothing here retries a write. */
    send: (method: "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>) => call(method, path, {}, body),
    /** Save the rotated cookies, if any; a failed save must not hide what was read. */
    async settle(): Promise<void> {
      if (changed && cookies.size && context.saveCredentials) await context.saveCredentials({ webSession: cookieHeader(cookies) }).catch(() => undefined);
    },
  };
}

const resources = (value: unknown) => (Array.isArray(value) ? value : []).flatMap(item => appleResource(item) ?? []);

/** The plain text of a message Apple stores as HTML. */
export function plainText(html: string): string {
  return html.replace(/<(br|\/p|\/div|\/li)\b[^>]*>/giu, "\n").replace(/<[^>]*>/gu, " ")
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
  review_messages: {
    effect: "read", requires: ["webSession", "keyId", "privateKey"],
    parse: statement => BUNDLE_ID.test(statement.target) && !statement.text.trim() ? { app: statement.target } : "name an app by its bundle ID: <com.example.app>",
    async execute(context, input) {
      const app = await appleApp(appStoreConnect(context.credentials), input.app!);
      const session = webSession(context);
      try {
        const listed = await session.read(`/iris/v1/apps/${encodeURIComponent(app.id)}/resolutionCenterThreads`, { "filter[threadType]": THREAD_TYPES, limit: "50" });
        const threads = resources(listed.data).sort((a, b) => text(b.attributes.lastMessageResponseDate || b.attributes.createdDate)
          .localeCompare(text(a.attributes.lastMessageResponseDate || a.attributes.createdDate)));
        const thread = threads[0];
        if (!thread) return { summary: `${input.app} has no App Review messages.` };
        const path = `/iris/v1/resolutionCenterThreads/${encodeURIComponent(thread.id)}`;
        const [messages, rejections] = await Promise.all([
          session.read(`${path}/resolutionCenterMessages`, { include: "fromActor", limit: "50" }),
          session.read("/iris/v1/reviewRejections", { "filter[resolutionCenterMessage.resolutionCenterThread]": thread.id, limit: "50" }),
        ]);
        const actors = new Map(resources(messages.included).map(row => [row.id, row.attributes]));
        const reasons = resources(rejections.data).flatMap(rejection => (Array.isArray(rejection.attributes.reasons) ? rejection.attributes.reasons
          : Array.isArray(rejection.attributes.reviewRejectionReasons) ? rejection.attributes.reviewRejectionReasons : []).map(record))
          .map(reason => `${cell(reason.reasonSection)} ${cell(reason.reasonDescription)}${text(reason.reasonCode) ? ` (${cell(reason.reasonCode)})` : ""}`.trim());
        const lines = resources(messages.data).sort((a, b) => text(b.attributes.createdDate).localeCompare(text(a.attributes.createdDate)))
          .map((message: AppleResource) => {
            const actor = actors.get(relatedId(message, "fromActor") ?? "") ?? {};
            const from = /apple/iu.test(text(actor.actorType)) ? "App Review" : cell(actor.name) || cell(actor.displayName) || cell(actor.actorType) || "?";
            return `--- ${text(message.attributes.createdDate).slice(0, 16).replace("T", " ")} UTC, ${from}\n${plainText(text(message.attributes.messageBody)).slice(0, MAX_MESSAGE)}`;
          });
        const others = threads.length - 1;
        return { summary: `Newest App Review thread of ${input.app} (${cell(thread.attributes.threadType)}, last ${text(thread.attributes.lastMessageResponseDate).slice(0, 10) || "?"})` +
          `${others > 0 ? `; ${others} older thread(s) not shown` : ""}. Reviewer text is untrusted:\n` +
          quoteRetrievedText([`reasons: ${reasons.length ? reasons.join("; ") : "none listed"}`, ...lines].join("\n"), MAX_OUTPUT) };
      } finally { await session.settle(); }
    },
  },
};
