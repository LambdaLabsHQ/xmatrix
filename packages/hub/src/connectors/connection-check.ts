import { verifyTeamsNativeConnection } from "./teams-native";
import { verifyDingTalkNativeConnection } from "./dingtalk-native";
import { verifyTelegramNativeConnection } from "./telegram-native";
import { verifyWeComNativeConnection } from "./wecom-native";
import { getAppConnectorProvider } from "../app-connectors";
import type { Env } from "../types";
import { connectionCredentials } from "./connection-credentials";
import { ProviderRequestError } from "./http";
import { connectorProvider } from "./registry";
import { verifyDiscordNativeConnection } from "./discord-native";
import { verifyFeishuNativeConnection } from "./feishu-native";
import { verifyGoogleChatNativeConnection } from "./googlechat-native";

/* What a connection's credentials are and whether they work. A connection is
   Connected only after this passes: the fields its manifest requires are
   stored, and the provider accepted them on one real call. */

/** Throws, with what to fix, unless the stored credentials are complete and the provider accepts them. */
export async function verifyConnectorConnection(env: Env, spaceId: string, providerId: string): Promise<void> {
  const manifest = getAppConnectorProvider(providerId);
  if (!manifest) throw new Error("Unknown app");
  if (providerId === "teams" && await verifyTeamsNativeConnection(env, spaceId)) return;
  if (providerId === "dingtalk" && await verifyDingTalkNativeConnection(env, spaceId)) return;
  if (providerId === "wecom" && await verifyWeComNativeConnection(env, spaceId)) return;
  if (providerId === "discord" && await verifyDiscordNativeConnection(env, spaceId)) return;
  if (providerId === "telegram" && await verifyTelegramNativeConnection(env, spaceId)) return;
  if (providerId === "feishu" && await verifyFeishuNativeConnection(env, spaceId)) return;
  if (providerId === "googlechat" && await verifyGoogleChatNativeConnection(env, spaceId)) return;
  const credentials = await connectionCredentials(env, spaceId, providerId);
  const missing = (manifest.credentials ?? [])
    .filter((field) => field.required && !field.generated && !field.managed && !credentials[field.id]);
  if (missing.length > 0) {
    throw new Error(`Save ${missing.map((field) => field.label).join(", ")} under Credentials`);
  }
  try {
    await connectorProvider(providerId)?.verify?.(credentials);
  } catch (error) {
    if (error instanceof ProviderRequestError) throw new Error(`${manifest.name} refused the credentials: ${error.message}`);
    throw new Error(error instanceof DOMException && error.name === "TimeoutError"
      ? `${manifest.name} did not answer in time` : `${manifest.name} could not be reached`);
  }
}
