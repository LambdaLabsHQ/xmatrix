import { plainRecord } from "@xmatrix/protocol";
import { isBoundedTrimmedUtf8String } from "../relay-v2-primitives";
import type { Env } from "../types";
import { providerJson, ProviderRequestError } from "./http";

export const DISCORD_ID = /^[1-9][0-9]{14,24}$/u;
const API = "https://discord.com/api/v10";
export function isDiscordInstallationGrant(values: Readonly<Record<string, string>>) {
  return ["oauthToken", "oauthRefreshToken", "oauthExpiresAt", "oauthClientId", "oauthGuildId", "oauthUserId", "oauthScopes"].some(field => !!values[field]);
}
export function discordScopes(value: unknown): boolean {
  const scopes = typeof value === "string" ? value.split(/\s+/u) : Array.isArray(value) ? value : [];
  return scopes.includes("bot") && scopes.includes("identify") && new Set(scopes).size === scopes.length &&
    scopes.every(scope => ["bot", "identify", "applications.commands"].includes(scope));
}
function invalidGrant(): never {
  throw new ProviderRequestError(502, "Discord did not confirm the server installation; reconnect");
}
export function validateDiscordGrant(payload: Record<string, unknown>): void {
  const seconds = typeof payload.expires_in === "number" || typeof payload.expires_in === "string" ? Number(payload.expires_in) : NaN;
  if (!isBoundedTrimmedUtf8String(payload.access_token, 4096) || !isBoundedTrimmedUtf8String(payload.refresh_token, 4096) ||
      payload.token_type !== "Bearer" || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604800 ||
      !isBoundedTrimmedUtf8String(payload.scope, 128) || !discordScopes(payload.scope)) invalidGrant();
}
/** All three app credentials stay in the server environment, never in a Space or Agent capability. */
export function discordCompanyApp(env: Env) {
  const vars = env as unknown as Record<string, unknown>;
  const read = (suffix: string) => vars[`CONNECTOR_DISCORD_${suffix}`];
  const clientId = read("CLIENT_ID"), clientSecret = read("CLIENT_SECRET"), botToken = read("BOT_TOKEN");
  if ([clientId, clientSecret, botToken].every(value => value === undefined || value === "")) return undefined;
  if (typeof clientId !== "string" || !DISCORD_ID.test(clientId) ||
      !isBoundedTrimmedUtf8String(clientSecret, 4096) || !isBoundedTrimmedUtf8String(botToken, 4096) ||
      /\s/u.test(clientSecret) || /\s/u.test(botToken)) {
    throw new ProviderRequestError(503, "Discord company application is not configured");
  }
  return { clientId, clientSecret, botToken };
}
/** Verify the exact bearer application and installing Human; discard all profile fields. */
export async function discordAuthorization(clientId: string, token: string, userId?: string): Promise<string> {
  const auth = await discordJson("/oauth2/@me", `Bearer ${token}`);
  const app = plainRecord(auth.application), user = plainRecord(auth.user);
  if (app?.id !== clientId || !discordScopes(auth.scopes) || !DISCORD_ID.test(String(user?.id ?? "")) ||
      user?.bot === true || (userId !== undefined && user?.id !== userId) ||
      typeof auth.expires !== "string" || !Number.isFinite(Date.parse(auth.expires)) || Date.parse(auth.expires) <= Date.now()) invalidGrant();
  return user!.id as string;
}
/** Only the authenticated token response supplies the guild. Callback query hints are ignored. */
export async function discordGrantContext(clientId: string, payload: Record<string, unknown>, previous?: Readonly<Record<string, string>>) {
  validateDiscordGrant(payload);
  const guild = plainRecord(payload.guild);
  const guildId = previous?.oauthGuildId ?? guild?.id;
  if (typeof guildId !== "string" || !DISCORD_ID.test(guildId) ||
      (previous && guild?.id !== undefined && guild.id !== guildId)) invalidGrant();
  const userId = await discordAuthorization(clientId, String(payload.access_token), previous?.oauthUserId);
  return { oauthClientId: clientId, oauthGuildId: guildId, oauthUserId: userId, oauthScopes: String(payload.scope) };
}
/** No provider body or credentials are included in action errors or callback diagnostics. */
export async function discordJson(path: string, authorization: string, json?: unknown) {
  try { return await providerJson(`${API}${path}`, { headers: { authorization }, ...(json !== undefined ? { method: "POST", json } : {}) }); }
  catch (error) {
    if (error instanceof ProviderRequestError) throw new ProviderRequestError(error.status, `Discord request failed (${error.status})`);
    throw error;
  }
}
export function validateDiscordCredentials(values: Readonly<Record<string, string>>, clientId: string): void {
  if (values.oauthClientId !== clientId || !DISCORD_ID.test(values.oauthGuildId ?? "") ||
      !DISCORD_ID.test(values.oauthUserId ?? "") || !discordScopes(values.oauthScopes) || values.botToken ||
      !isBoundedTrimmedUtf8String(values.oauthToken, 4096) || !isBoundedTrimmedUtf8String(values.oauthRefreshToken, 4096) ||
      !Number.isSafeInteger(Number(values.oauthExpiresAt)) || Number(values.oauthExpiresAt) < 1) invalidGrant();
}
export async function verifyDiscordBot(app: NonNullable<ReturnType<typeof discordCompanyApp>>, guildId: string) {
  const bot = await discordJson("/oauth2/applications/@me", `Bot ${app.botToken}`);
  if (bot.id !== app.clientId || bot.bot_public !== true || bot.bot_require_code_grant !== true) {
    throw new ProviderRequestError(503, "Discord company bot must be public and require the OAuth code grant");
  }
  const guild = await discordJson(`/guilds/${guildId}`, `Bot ${app.botToken}`);
  if (guild.id !== guildId) invalidGrant();
}
