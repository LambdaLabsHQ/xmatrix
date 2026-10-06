import { teamsAppIdentity, teamsReference, type TeamsAppIdentity } from "@xmatrix/db";
import type { Env } from "../types";
import { connectorCredentialRepository, connectorTeamsRoomRepository } from "./credentials";
import { teamsBotClient } from "./teams-api";
import { ProviderRequestError } from "./http";
import type { ConnectorActionContext } from "./provider";

export function teamsNativeApp(env: Env) {
  const vars = env as unknown as Record<string, unknown>;
  const values = ["APP_ID", "APP_SECRET", "TENANT_ID"].map(name => vars[`CONNECTOR_TEAMS_${name}`]);
  if (values.every(value => value === undefined || value === "")) return undefined;
  if (values.some(value => typeof value !== "string" || !value)) throw new ProviderRequestError(503, "Teams company bot is not configured");
  const app: TeamsAppIdentity = { providerId: "teams", appId: values[0] as string, tenantId: values[2] as string };
  try { teamsAppIdentity(app); return { app, client: teamsBotClient(app, values[1] as string) }; }
  catch { throw new ProviderRequestError(503, "Teams company bot is not configured"); }
}
export const TEAMS_NATIVE_DEPENDENCIES = { app: teamsNativeApp, rooms: connectorTeamsRoomRepository, credentials: connectorCredentialRepository };

/** Manual mode is explicit credential replacement; inactive native mode never falls back to it. */
export async function teamsActionCapability(env: Env, spaceId: string, authorize: () => Promise<void>, dependencies = TEAMS_NATIVE_DEPENDENCIES):
  Promise<ConnectorActionContext["teams"] | undefined> {
  const manual = await dependencies.credentials(env).resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "teams" });
  if (manual?.values.webhookUrl) return undefined;
  const native = dependencies.app(env);
  if (!native) return undefined;
  const rooms = dependencies.rooms(env);
  const captured = await rooms.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId });
  if (!captured?.teamsReference) throw new ProviderRequestError(409, "Link a Teams conversation in Apps before posting");
  const reference = teamsReference(captured.teamsReference, native.app);
  const live = async () => {
    if (!await rooms.current({ requestId: crypto.randomUUID(), app: native.app, binding: captured })) {
      throw new ProviderRequestError(409, "Teams authorization changed; reconnect before posting");
    }
    await authorize();
  };
  return { async postMessage(text) {
    await live();
    await native.client.member(reference);
    await live();
    await native.client.post(reference, text, live);
  } };
}
export async function verifyTeamsNativeConnection(env: Env, spaceId: string, dependencies = TEAMS_NATIVE_DEPENDENCIES): Promise<boolean> {
  const manual = await dependencies.credentials(env).resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "teams" });
  if (manual?.values.webhookUrl) return false;
  const native = dependencies.app(env);
  if (!native) return false;
  const rooms = dependencies.rooms(env);
  const captured = await rooms.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
  if (!captured?.teamsReference) throw new ProviderRequestError(409, "Link a Teams conversation in Apps before checking");
  await native.client.member(teamsReference(captured.teamsReference, native.app));
  const current = await rooms.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
  if (!current || current.grantGeneration !== captured.grantGeneration || current.connectionGeneration !== captured.connectionGeneration) {
    throw new ProviderRequestError(409, "Teams authorization changed during Check");
  }
  return true;
}
