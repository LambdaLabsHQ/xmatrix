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
 * from the Hub with it, so no machine has to stay on. Apple rotates some of
 * the cookies as they are used; the rotated values are saved back into the
 * same credential. The Apple ID password never reaches xMatrix. The session
 * lasts about 30 days, and signing in again is the only renewal.
 *
 * Only reads, only Apple's own origin, no redirects followed: a redirect is
 * Apple asking for a new sign-in. What reviewers wrote is untrusted text.
 */

const ORIGIN = "https://appstoreconnect.apple.com";
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT = 12_000;
const MAX_MESSAGE = 3_000;
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const THREAD_TYPES = "REJECTION_BINARY,REJECTION_METADATA,REJECTION_REVIEW_SUBMISSION,APP_MESSAGE_ARC,APP_MESSAGE_ARB,APP_MESSAGE_COMM,APP_MESSAGE_INFORMATIONAL";
const EXPIRED = "The App Store Connect web session is missing or has expired; sign in at appstoreconnect.apple.com and save a new one under Credentials";

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

/** One web session for the duration of an action; rotated cookies are saved once at its end. */
export function webSession(context: Pick<ConnectorActionContext, "credentials" | "saveCredentials">) {
  const cookies = parseCookies(context.credentials.webSession ?? "");
  let changed = false;
  const read = async (path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> => {
    if (!cookies.size) throw new ProviderRequestError(401, EXPIRED);
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !/^\/(iris\/v1|olympus\/v1)\//u.test(url.pathname)) throw new ProviderRequestError(502, "App Store Connect returned a link outside its website API");
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { cookie: cookieHeader(cookies),
      accept: "application/json", "x-requested-with": "XMLHttpRequest", origin: ORIGIN, referer: `${ORIGIN}/`, "user-agent": "xMatrix-Connectors" } });
    changed = applySetCookies(cookies, setCookies(response.headers)) || changed;
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new ProviderRequestError(401, EXPIRED);
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_BYTES) throw new ProviderRequestError(502, "App Store Connect's answer is too large");
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(body)); } catch { payload = undefined; }
    if (!response.ok || !payload || typeof payload !== "object") {
      throw new ProviderRequestError(response.ok ? 502 : response.status, response.ok ? "App Store Connect did not answer with JSON; the website may have changed"
        : `App Store Connect's website returned ${response.status}`);
    }
    return payload as Record<string, unknown>;
  };
  return {
    read,
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
          "It lasts about 30 days from sign-in; when it lapses, review_messages says so." };
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
