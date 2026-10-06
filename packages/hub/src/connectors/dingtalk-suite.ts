import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { sha256Hex, timingSafeEqual, utf8ByteLength } from "@xmatrix/protocol";
import { dingtalkAppIdentity } from "@xmatrix/db";
import type { Env } from "../types";
import { readBoundedRequestBody } from "../index-shared";
import { connectorDingTalkSuiteRepository } from "./credentials";
import { decryptCallbackEnvelope, encryptCallbackEnvelope } from "./aes-callback-envelope";
import { ProviderRequestError } from "./http";

const rejected = () => new ProviderRequestError(401, "DingTalk suite authentication failed");
const unavailable = () => new ProviderRequestError(503, "DingTalk company suite is not configured");
export async function dingtalkNativeSuite(env: Env) {
  const vars = env as unknown as Record<string, unknown>;
  const values = ["SUITE_KEY", "SUITE_SECRET", "CALLBACK_TOKEN", "ENCODING_AES_KEY"].map(key => vars[`CONNECTOR_DINGTALK_${key}`]);
  if (values.every(value => value === undefined || value === "")) return undefined;
  if (values.some(value => typeof value !== "string" || value !== value.trim())) throw unavailable();
  const [suiteKey, suiteSecret, token, aesKey] = values as [string, string, string, string];
  if (!/^[A-Za-z0-9_-]{3,128}$/u.test(suiteKey) || !/^[A-Za-z0-9_.-]{8,256}$/u.test(suiteSecret) ||
      !/^[A-Za-z0-9]{3,32}$/u.test(token) || !/^[A-Za-z0-9+/]{43}$/u.test(aesKey) ||
      Buffer.from(aesKey + "=", "base64").toString("base64") !== aesKey + "=") throw unavailable();
  const app = { suiteKey, eventKeyDigest: await sha256Hex(JSON.stringify([suiteSecret, token, aesKey])) };
  dingtalkAppIdentity(app);
  return { app, suiteSecret, token, aesKey };
}
type Native = NonNullable<Awaited<ReturnType<typeof dingtalkNativeSuite>>>;

/** Provider aliases are bounded: exactly one spelling, never duplicate or conflicting values. */
function parameter(query: URLSearchParams, names: string[]) {
  const values = names.flatMap(name => query.getAll(name));
  if (values.length !== 1) throw rejected();
  return values[0]!;
}
export function dingtalkEventTime(value: unknown, now = Date.now()): number {
  const text = String(value);
  if (!/^(?:[1-9][0-9]{9}|[1-9][0-9]{12})$/u.test(text)) throw rejected();
  const at = Number(text) * (text.length === 10 ? 1000 : 1);
  if (at < now - 600_000 || at > now + 30_000) throw rejected();
  return at;
}
function signature(native: Native, timestamp: string, nonce: string, encrypted: string): string {
  return createHash("sha1").update([native.token, timestamp, nonce, encrypted].sort().join(""), "utf8").digest("hex");
}
export function verifyDingTalkSuiteCallback(native: Native, url: string, encrypted: string, now = Date.now()): string {
  const query = new URL(url).searchParams;
  const supplied = parameter(query, ["msg_signature", "signature"]), timestamp = parameter(query, ["timeStamp", "timestamp"]);
  const nonce = parameter(query, ["nonce"]);
  dingtalkEventTime(timestamp, now);
  if (!/^[a-fA-F0-9]{40}$/u.test(supplied) || !/^[!-~]{1,128}$/u.test(nonce) ||
      !timingSafeEqual(supplied.toLowerCase(), signature(native, timestamp, nonce, encrypted))) throw rejected();
  return decryptCallbackEnvelope(native.aesKey, native.app.suiteKey, encrypted);
}

/** These registration events are flat JSON. Detect duplicate/escaped keys and reject nested or lossy numbers. */
export function dingtalkFlatJson(source: string): Record<string, string | number> {
  if (utf8ByteLength(source) > 32 * 1024) throw new ProviderRequestError(413, "DingTalk callback exceeds its bound");
  const inner = source.match(/^\s*\{\s*([\s\S]*?)\s*\}\s*$/u)?.[1];
  if (inner === undefined) throw rejected();
  const fields: Record<string, string | number> = Object.create(null);
  // JSON string grammar excludes raw U+0000–U+001F before parsing each value.
  // oxlint-disable-next-line no-control-regex
  const entries = /\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\s*:\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*))\s*(,|$)/gy;
  let offset = 0, match: RegExpExecArray | null;
  while ((match = entries.exec(inner))) {
    const key = JSON.parse(match[1]!) as string, value = JSON.parse(match[2]!) as string | number;
    if (Object.hasOwn(fields, key) || Object.keys(fields).length >= 12 || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) ||
        typeof value === "number" && !Number.isSafeInteger(value) || typeof value === "string" && (value.includes("\u0000") || value.includes("\uFEFF")) ||
        match[3] === "," && entries.lastIndex === inner.length) throw rejected();
    fields[key] = value; offset = entries.lastIndex;
  }
  if (offset !== inner.length || !Object.keys(fields).length) throw rejected();
  return fields;
}
export function dingTalkEncryptedResponse(native: Native, message: string): Response {
  const timeStamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomUUID().replaceAll("-", "");
  const encrypt = encryptCallbackEnvelope(native.aesKey, native.app.suiteKey, message);
  return Response.json({ msg_signature: signature(native, timeStamp, nonce, encrypt), encrypt, timeStamp, nonce },
    { headers: { "cache-control": "no-store" } });
}

/** The configured SyncHTTP business URL receives the same native registration challenges. */
export function dingTalkSuiteChallenge(native: Native, payload: Record<string, string | number>): Response | undefined {
  if (payload.EventType === "check_url") {
    if (Object.keys(payload).some(key => !["EventType", "SuiteKey", "TimeStamp"].includes(key)) ||
        payload.SuiteKey !== undefined && payload.SuiteKey !== native.app.suiteKey) throw rejected();
    if (payload.TimeStamp !== undefined) dingtalkEventTime(payload.TimeStamp);
    return dingTalkEncryptedResponse(native, "success");
  }
  if (["check_create_suite_url", "check_update_suite_url"].includes(String(payload.EventType))) {
    if (payload.TestSuiteKey !== native.app.suiteKey || typeof payload.Random !== "string" ||
        !/^[!-~]{1,256}$/u.test(payload.Random) || Object.keys(payload).some(key =>
          !["EventType", "TestSuiteKey", "Random", "TimeStamp"].includes(key))) throw rejected();
    if (payload.TimeStamp !== undefined) dingtalkEventTime(payload.TimeStamp);
    return dingTalkEncryptedResponse(native, payload.Random);
  }
  return undefined;
}

export const DINGTALK_SUITE_DEPENDENCIES = { native: dingtalkNativeSuite, repository: connectorDingTalkSuiteRepository };
export async function handleDingTalkSuiteCallback(env: Env, request: Request, dependencies = DINGTALK_SUITE_DEPENDENCIES): Promise<Response> {
  try {
    const native = await dependencies.native(env);
    if (!native) throw unavailable();
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const bytes = await readBoundedRequestBody(request, 32 * 1024);
    if (!bytes) throw new ProviderRequestError(413, "DingTalk callback exceeds its bound");
    const outer = dingtalkFlatJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (Object.keys(outer).length !== 1 || typeof outer.encrypt !== "string") throw rejected();
    const payload = dingtalkFlatJson(verifyDingTalkSuiteCallback(native, request.url, outer.encrypt));
    const challenge = dingTalkSuiteChallenge(native, payload);
    if (challenge) return challenge;
    if (payload.SuiteKey !== native.app.suiteKey) throw rejected();
    const at = dingtalkEventTime(payload.TimeStamp);
    // No Human/Space consent exists at this boundary; never acknowledge an installation as processed.
    if (payload.EventType !== "suite_ticket" && payload.EventType !== "suite_ticket ") return Response.json(
      { error: "DingTalk company installation and lifecycle processing is not available" }, { status: 503, headers: { "cache-control": "no-store" } });
    if (Object.keys(payload).some(key => !["SuiteKey", "EventType", "TimeStamp", "SuiteTicket"].includes(key)) ||
        typeof payload.SuiteTicket !== "string" || !/^[!-~]{1,512}$/u.test(payload.SuiteTicket)) throw rejected();
    await dependencies.repository(env).acceptTicket({ requestId: crypto.randomUUID(), app: native.app,
      eventId: await sha256Hex(JSON.stringify([payload.SuiteKey, "suite_ticket", at, payload.SuiteTicket])),
      eventTime: new Date(at).toISOString(), ticket: payload.SuiteTicket });
    return dingTalkEncryptedResponse(native, "success");
  } catch (error) {
    const status = error instanceof ProviderRequestError && [400, 401, 413].includes(error.status) ? error.status : 503;
    return Response.json({ error: status === 503 ? "DingTalk suite callback is unavailable or unconfigured" : "DingTalk suite callback was rejected" },
      { status, headers: { "cache-control": "no-store" } });
  }
}
