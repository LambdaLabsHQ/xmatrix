import { googleChatAppIdentity, type GoogleChatAppIdentity } from "@xmatrix/db";
import type { Env } from "../types";
import { connectorGoogleChatRoomRepository } from "./credentials";
import { googleChatAppClient } from "./googlechat-app-auth";
import { ProviderRequestError } from "./http";
import type { ConnectorActionContext } from "./provider";

/** App-level credentials never become Space credential values or Agent-readable fields. */
export function googleChatNativeApp(env: Env) {
  const vars = env as unknown as Record<string, unknown>;
  const names = ["SERVICE_ACCOUNT_JSON", "APP_ID", "SYSTEM_SERVICE_ACCOUNT_EMAIL"];
  const values = names.map(name => vars[`CONNECTOR_GOOGLECHAT_${name}`]);
  if (values.every(value => value === undefined || value === "")) return undefined;
  if (values.some(value => typeof value !== "string" || !value)) {
    throw new ProviderRequestError(503, "Google Chat application authentication is not configured");
  }
  const client = googleChatAppClient(values[0] as string);
  const app: GoogleChatAppIdentity = { appId: values[1] as string,
    systemServiceAccountEmail: values[2] as string, serviceAccountEmail: client.serviceAccountEmail };
  try { googleChatAppIdentity(app); }
  catch { throw new ProviderRequestError(503, "Google Chat application identity is not configured"); }
  return { app, client };
}

export const GOOGLECHAT_NATIVE_DEPENDENCIES = { app: googleChatNativeApp, rooms: connectorGoogleChatRoomRepository };

/** Native post is a room-scoped server capability, not an arbitrary SA client or room parameter. */
export async function googleChatActionCapability(env: Env, spaceId: string, authorize: () => Promise<void>,
  dependencies = GOOGLECHAT_NATIVE_DEPENDENCIES):
  Promise<ConnectorActionContext["googleChat"] | undefined> {
  const native = dependencies.app(env);
  if (!native) return undefined;
  const repository = dependencies.rooms(env);
  const captured = await repository.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId });
  if (!captured) return undefined;
  return { async postMessage(text) {
    const live = async () => {
      if (!await repository.current({ requestId: crypto.randomUUID(), app: native.app, binding: captured })) {
        throw new ProviderRequestError(409, "Google Chat connection changed; reconnect before posting");
      }
      await authorize();
    };
    await live();
    await native.client.postMessage(captured.chatSpace, text, live);
  } };
}

export async function verifyGoogleChatNativeConnection(env: Env, spaceId: string,
  dependencies = GOOGLECHAT_NATIVE_DEPENDENCIES): Promise<boolean> {
  const native = dependencies.app(env);
  if (!native) return false;
  const repository = dependencies.rooms(env);
  const captured = await repository.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
  if (!captured) return false;
  await native.client.getSpace(captured.chatSpace);
  const current = await repository.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
  if (!current || current.grantGeneration !== captured.grantGeneration) {
    throw new ProviderRequestError(409, "Google Chat connection changed during Check");
  }
  return true;
}
