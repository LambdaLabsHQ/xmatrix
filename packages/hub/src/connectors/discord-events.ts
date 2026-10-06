import { plainRecord } from "@xmatrix/protocol";
import { readBoundedRequestBody } from "../index-shared";
import type { Env } from "../types";
import { connectorDiscordLifecycleRepository } from "./credentials";
import { discordCompanyApp, discordScopes, DISCORD_ID } from "./discord-oauth";

const MAX_SKEW_SECONDS = 300;
const MAX_EVENT_AGE_MS = 15 * 60_000;
const dependencies = { app: discordCompanyApp, lifecycle: connectorDiscordLifecycleRepository };
const refuse = (status: number, error: string) => Response.json({ error }, { status });
const acknowledge = () => new Response(null, { status: 204, headers: { "content-type": "application/json" } });
const bytesFromHex = (hex: string) => Uint8Array.from(hex.match(/../gu)!, pair => parseInt(pair, 16));

/** Discord Webhook Events, not interactions, incoming webhooks or Gateway messages. */
export async function handleDiscordLifecycleDelivery(env: Env, request: Request,
  services = dependencies, now = Date.now()): Promise<Response> {
  const app = services.app(env);
  const publicKey = (env as unknown as Record<string, unknown>).CONNECTOR_DISCORD_PUBLIC_KEY;
  if (!app || typeof publicKey !== "string" || !/^[a-fA-F0-9]{64}$/u.test(publicKey)) {
    return refuse(404, "Discord lifecycle endpoint is not configured");
  }
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  if (!/^[1-9][0-9]{9,10}$/u.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS ||
      !/^[a-fA-F0-9]{128}$/u.test(signature)) return refuse(401, "Invalid Discord signature");
  const body = await readBoundedRequestBody(request, 256 * 1024);
  if (!body) return refuse(413, "Discord lifecycle delivery is too large");
  const prefix = new TextEncoder().encode(timestamp);
  const signed = new Uint8Array(prefix.length + body.byteLength);
  signed.set(prefix); signed.set(new Uint8Array(body), prefix.length);
  const verified = await (async () => {
    const key = await crypto.subtle.importKey("raw", bytesFromHex(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, bytesFromHex(signature), signed);
  })().catch(() => false);
  if (!verified) return refuse(401, "Invalid Discord signature");
  let payload: Record<string, unknown> | undefined;
  try { payload = plainRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))); }
  catch { return refuse(400, "Invalid Discord lifecycle payload"); }
  if (!payload || payload.version !== 1 || payload.application_id !== app.clientId || ![0, 1].includes(Number(payload.type)) ||
      typeof payload.type !== "number") return refuse(400, "Invalid Discord application envelope");
  // Native PING requires a valid Content-Type on its empty 204, without PostgreSQL.
  if (payload.type === 0) return acknowledge();
  const event = plainRecord(payload.event);
  if (!event || typeof event.type !== "string") return refuse(400, "Missing Discord lifecycle event");
  // Ordinary guild MESSAGE_CREATE and Social SDK messages have no route here.
  if (!["APPLICATION_AUTHORIZED", "APPLICATION_DEAUTHORIZED"].includes(event.type)) return acknowledge();
  const data = plainRecord(event.data), user = plainRecord(data?.user);
  const timestampText = typeof event.timestamp === "string" ? event.timestamp : "";
  // Discord's documented examples omit a zone; interpret those ISO values as UTC.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/u.test(timestampText)) {
    return refuse(400, "Invalid Discord event timestamp");
  }
  const calendar = new Date(`${timestampText.slice(0, 19)}Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== timestampText.slice(0, 19)) {
    return refuse(400, "Invalid Discord event timestamp");
  }
  const eventAt = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/u.test(timestampText) ? timestampText : `${timestampText}Z`);
  if (!Number.isFinite(eventAt) || eventAt > now + 30_000 || eventAt < now - MAX_EVENT_AGE_MS ||
      typeof user?.id !== "string" || !DISCORD_ID.test(user.id) || user.bot === true) {
    return refuse(400, "Invalid Discord lifecycle identity or time");
  }
  let guildId: string | undefined;
  if (event.type === "APPLICATION_AUTHORIZED") {
    // User installs are outside the company's Guild Install contract.
    if (data?.integration_type === 1) return acknowledge();
    guildId = plainRecord(data?.guild)?.id as string | undefined;
    if ((data?.integration_type !== undefined && data.integration_type !== 0) || typeof guildId !== "string" || !DISCORD_ID.test(guildId) || !discordScopes(data?.scopes)) {
      return refuse(400, "Invalid Discord guild authorization");
    }
  }
  // No request Space, guild hints on DEAUTHORIZED, user profile or raw body crosses this boundary.
  await services.lifecycle(env).receive({ requestId: crypto.randomUUID(), appClientId: app.clientId,
    userId: user.id, type: event.type as "APPLICATION_AUTHORIZED" | "APPLICATION_DEAUTHORIZED",
    eventAt: new Date(eventAt).toISOString(), ...(guildId ? { guildId } : {}) });
  return acknowledge();
}
