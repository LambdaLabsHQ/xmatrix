import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { sha256Hex, timingSafeEqual, utf8ByteLength } from "@xmatrix/protocol";
import { decryptCallbackEnvelope } from "./aes-callback-envelope";
import { wecomAppIdentity } from "@xmatrix/db";
import type { Env } from "../types";
import { readBoundedRequestBody } from "../index-shared";
import { connectorWeComSuiteRepository, connectorWeComCompanyRepository } from "./credentials";
import { ProviderRequestError } from "./http";

/** A pushed ticket authenticates the app, never a Space, company installation or recipient. */
export async function wecomNativeSuite(env: Env) {
  const vars = env as unknown as Record<string, unknown>;
  const values = ["SUITE_ID", "SUITE_SECRET", "CALLBACK_TOKEN", "ENCODING_AES_KEY"].map(key => vars[`CONNECTOR_WECOM_${key}`]);
  if (values.every(value => value === undefined || value === "")) return undefined;
  if (values.some(value => typeof value !== "string" || value !== value.trim())) throw unavailable();
  const [suiteId, suiteSecret, token, aesKey] = values as [string, string, string, string];
  if (!/^(?:ww|wx)[A-Za-z0-9]{8,64}$/u.test(suiteId) || !/^[A-Za-z0-9_.-]{8,256}$/u.test(suiteSecret) ||
      !/^[A-Za-z0-9]{1,32}$/u.test(token) || !/^[A-Za-z0-9+/]{43}$/u.test(aesKey) ||
      Buffer.from(aesKey + "=", "base64").toString("base64") !== aesKey + "=") throw unavailable();
  const app = { suiteId, eventKeyDigest: await sha256Hex(JSON.stringify([suiteSecret, token, aesKey])) };
  wecomAppIdentity(app);
  return { app, suiteSecret, token, aesKey };
}
const unavailable = () => new ProviderRequestError(503, "WeCom company suite is not configured");
const unauthenticated = () => new ProviderRequestError(401, "WeCom suite authentication failed");
type Native = NonNullable<Awaited<ReturnType<typeof wecomNativeSuite>>>;

/** Deliberately flat XML: no DTD, entities, attributes, nesting, duplicate tags or parser expansion. */
export function wecomFlatXml(xml: string): Record<string, string> {
  if (utf8ByteLength(xml) > 32 * 1024) throw new ProviderRequestError(413, "WeCom callback exceeds its bound");
  const inner = xml.match(/^\s*<xml>\s*([\s\S]*?)\s*<\/xml>\s*$/u)?.[1];
  if (inner === undefined) throw unauthenticated();
  const fields: Record<string, string> = Object.create(null);
  const tags = /\s*<([A-Za-z][A-Za-z0-9]{0,31})>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>\s*/gy;
  let offset = 0, match: RegExpExecArray | null;
  while ((match = tags.exec(inner))) {
    const key = match[1]!, value = match[2] ?? match[3] ?? "";
    if (Object.hasOwn(fields, key) || Object.keys(fields).length >= 12 || value.includes("\u0000") || value.includes("\uFEFF") ||
        match[2] === undefined && /&(?!amp;|lt;|gt;|quot;|apos;)/u.test(value)) throw unauthenticated();
    // Numeric and external entities are intentionally unsupported; callback fields need no entity expansion.
    fields[key] = match[2] !== undefined ? value : value.replace(/&(amp|lt|gt|quot|apos);/gu,
      (_whole, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]!);
    offset = tags.lastIndex;
  }
  if (offset !== inner.length || !Object.keys(fields).length) throw unauthenticated();
  return fields;
}
/** Signature verification precedes AES and inner XML parsing; the exact suite must match inside the cipher. */
export function verifyWeComSuiteCallback(native: Native, requestUrl: string, encrypted: string, now = Date.now()): string {
  const query = new URL(requestUrl).searchParams;
  if (["msg_signature", "timestamp", "nonce"].some(key => query.getAll(key).length !== 1)) throw unauthenticated();
  const signature = query.get("msg_signature")!, timestamp = query.get("timestamp")!, nonce = query.get("nonce")!;
  if (!/^[a-fA-F0-9]{40}$/u.test(signature) || !/^[1-9][0-9]{9}$/u.test(timestamp) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(nonce) || Number(timestamp) * 1000 < now - 600_000 || Number(timestamp) * 1000 > now + 30_000) throw unauthenticated();
  const expected = createHash("sha1").update([native.token, timestamp, nonce, encrypted].sort().join(""), "utf8").digest("hex");
  if (!timingSafeEqual(signature.toLowerCase(), expected)) throw unauthenticated();
  return decryptCallbackEnvelope(native.aesKey, native.app.suiteId, encrypted);
}
export const WECOM_SUITE_DEPENDENCIES = { native: wecomNativeSuite, repository: connectorWeComSuiteRepository, companies: connectorWeComCompanyRepository };
export async function handleWeComSuiteCallback(env: Env, request: Request, dependencies = WECOM_SUITE_DEPENDENCIES): Promise<Response> {
  try {
    const native = await dependencies.native(env);
    if (!native) throw unavailable();
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams;
      if (query.getAll("echostr").length !== 1) throw unauthenticated();
      const challenge = verifyWeComSuiteCallback(native, request.url, query.get("echostr")!);
      if (!/^[A-Za-z0-9_-]{1,256}$/u.test(challenge)) throw unauthenticated();
      return new Response(challenge, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const bytes = await readBoundedRequestBody(request, 32 * 1024);
    if (!bytes) throw new ProviderRequestError(413, "WeCom callback exceeds its bound");
    const outer = wecomFlatXml(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!outer.Encrypt || Object.keys(outer).some(key => !["Encrypt", "ToUserName", "AgentID"].includes(key)) ||
        outer.ToUserName !== undefined && outer.ToUserName !== native.app.suiteId || outer.AgentID !== undefined) throw unauthenticated();
    const plaintext = verifyWeComSuiteCallback(native, request.url, outer.Encrypt);
    const payload = wecomFlatXml(plaintext);
    if (payload.SuiteId !== native.app.suiteId || !/^[1-9][0-9]{9}$/u.test(payload.TimeStamp ?? "")) throw unauthenticated();
    const at = Number(payload.TimeStamp) * 1000, now = Date.now();
    if (at < now - 600_000 || at > now + 30_000) throw unauthenticated();
    if (["change_auth", "cancel_auth"].includes(payload.InfoType ?? "")) {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(payload.AuthCorpId ?? "") ||
          Object.keys(payload).some(key => !["SuiteId", "InfoType", "TimeStamp", "AuthCorpId", "State", "ExtraInfo"].includes(key))) throw unauthenticated();
      await dependencies.companies(env, true).retire({ requestId: crypto.randomUUID(), app: native.app,
        corpId: payload.AuthCorpId!, eventTime: new Date(at).toISOString() });
      return new Response("success", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    // Website authorization returns its code to the Human confirmation flow. Marketplace installation remains separate.
    if (payload.InfoType !== "suite_ticket") return new Response("WeCom installation processing is not available", { status: 503 });
    if (Object.keys(payload).some(key => !["SuiteId", "InfoType", "TimeStamp", "SuiteTicket"].includes(key)) ||
        !/^[!-~]{1,512}$/u.test(payload.SuiteTicket ?? "")) throw unauthenticated();
    await dependencies.repository(env).acceptTicket({ requestId: crypto.randomUUID(), app: native.app,
      eventId: await sha256Hex(JSON.stringify([payload.SuiteId, payload.InfoType, payload.TimeStamp, payload.SuiteTicket])), eventTime: new Date(at).toISOString(), ticket: payload.SuiteTicket! });
    return new Response("success", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof ProviderRequestError && [400, 401, 413].includes(error.status) ? error.status : 503;
    return Response.json({ error: status === 503 ? "WeCom suite callback is unavailable or unconfigured" : "WeCom suite callback was rejected" }, { status });
  }
}
