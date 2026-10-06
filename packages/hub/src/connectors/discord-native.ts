import type { ResolvedAppCredentials } from "@xmatrix/db";
import type { Env } from "../types";
import { connectorCredentialRepository } from "./credentials";
import { connectionCredentials } from "./connection-credentials";
import { DISCORD_ID, isDiscordInstallationGrant, discordAuthorization, discordCompanyApp, discordJson, validateDiscordCredentials, verifyDiscordBot } from "./discord-oauth";
import { ProviderRequestError } from "./http";
import type { ConnectorActionContext } from "./provider";

export const DISCORD_NATIVE_DEPENDENCIES = {
  app: discordCompanyApp, credentials: connectorCredentialRepository, refresh: connectionCredentials,
  authorization: discordAuthorization, verifyBot: verifyDiscordBot, json: discordJson,
};
function sameInstallation(left: ResolvedAppCredentials, right: ResolvedAppCredentials | null) {
  return !!right && right.connectionVersion === left.connectionVersion && right.connectionGeneration === left.connectionGeneration &&
    right.values.oauthClientId === left.values.oauthClientId && right.values.oauthGuildId === left.values.oauthGuildId &&
    right.values.oauthUserId === left.values.oauthUserId && right.version >= left.version && right.version <= left.version + 1;
}
function sameGrant(left: ResolvedAppCredentials, right: ResolvedAppCredentials | null) {
  return !!right && right.connectionId === left.connectionId && right.spaceId === left.spaceId && right.providerId === "discord" &&
    right.version === left.version && right.connectionVersion === left.connectionVersion &&
    right.connectionGeneration === left.connectionGeneration && right.status === left.status;
}
/** A per-Space, provider-confirmed guild capability; never exposes the shared bot or bearer token. */
export async function discordActionCapability(env: Env, spaceId: string, authorize: () => Promise<void>,
  dependencies = DISCORD_NATIVE_DEPENDENCIES): Promise<ConnectorActionContext["discord"] | undefined> {
  const repository = dependencies.credentials(env);
  const first = await repository.resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "discord" });
  if (!first || !isDiscordInstallationGrant(first.values)) return undefined;
  await dependencies.refresh(env, spaceId, "discord");
  const captured = await repository.resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "discord" });
  const app = dependencies.app(env);
  if (!captured || !app || !sameInstallation(first, captured) || captured.status !== "configured") throw new ProviderRequestError(409, "Reconnect the Discord company bot");
  validateDiscordCredentials(captured.values, app.clientId);
  const live = async () => {
    if (!sameGrant(captured, await repository.resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "discord" }))) {
      throw new ProviderRequestError(409, "Discord connection changed before posting");
    }
    await authorize();
  };
  return { async postMessage(channel, text) {
    if (!DISCORD_ID.test(channel) || !text || text.length > 2000) throw new ProviderRequestError(400, "Invalid Discord message");
    await live();
    await dependencies.authorization(app.clientId, captured.values.oauthToken!, captured.values.oauthUserId);
    await dependencies.verifyBot(app, captured.values.oauthGuildId!);
    const target = await dependencies.json(`/channels/${channel}`, `Bot ${app.botToken}`);
    if (target.id !== channel || target.guild_id !== captured.values.oauthGuildId || (target.type !== 0 && target.type !== 5)) {
      throw new ProviderRequestError(403, "Choose a text channel in the Discord server you installed");
    }
    await live();
    const result = await dependencies.json(`/channels/${channel}/messages`, `Bot ${app.botToken}`,
      { content: text, allowed_mentions: { parse: [], replied_user: false } });
    if (result.channel_id !== channel || typeof result.id !== "string" || !DISCORD_ID.test(result.id)) {
      throw new ProviderRequestError(502, "Discord did not confirm message delivery");
    }
  } };
}

export async function verifyDiscordNativeConnection(env: Env, spaceId: string,
  dependencies = DISCORD_NATIVE_DEPENDENCIES): Promise<boolean> {
  const repository = dependencies.credentials(env);
  const first = await repository.resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "discord" });
  if (!first || !isDiscordInstallationGrant(first.values)) return false;
  await dependencies.refresh(env, spaceId, "discord");
  const captured = await repository.resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "discord" });
  const app = dependencies.app(env);
  if (!captured || !app || !sameInstallation(first, captured)) throw new ProviderRequestError(409, "Reconnect the Discord company bot");
  validateDiscordCredentials(captured.values, app.clientId);
  await dependencies.authorization(app.clientId, captured.values.oauthToken!, captured.values.oauthUserId);
  await dependencies.verifyBot(app, captured.values.oauthGuildId!);
  if (!sameGrant(captured, await repository.resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "discord" }))) {
    throw new ProviderRequestError(409, "Discord connection changed during Check");
  }
  return true;
}
