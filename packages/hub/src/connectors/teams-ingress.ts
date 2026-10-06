import { teamsAppIdentity } from "@xmatrix/db";
import { readBoundedRequestBody } from "../index-shared";
import type { Env } from "../types";
import { connectorAppRepository, connectorTeamsRoomRepository } from "./credentials";
import { CONNECTOR_DELIVERY_EFFECTS, deliverEvent, deliverConnectorRoom } from "./event-ingress";
import { parseJsonObject } from "./event-format";
import { teamsNativeApp } from "./teams-native";
import { teamsInteraction } from "./teams-events";
import { verifyTeamsRequest } from "./teams-api";
import { ProviderRequestError } from "./http";

export const TEAMS_INGRESS_DEPENDENCIES = { native: teamsNativeApp, rooms: connectorTeamsRoomRepository,
  apps: connectorAppRepository, verify: verifyTeamsRequest, deliver: deliverEvent, ...CONNECTOR_DELIVERY_EFFECTS };

export async function handleTeamsAppDelivery(env: Env, request: Request, dependencies = TEAMS_INGRESS_DEPENDENCIES): Promise<Response> {
  const native = dependencies.native(env);
  if (!native) return Response.json({ error: "Teams company bot is not configured" }, { status: 503 });
  const bytes = await readBoundedRequestBody(request, 32 * 1024);
  if (!bytes) return Response.json({ error: "Teams activity is too large" }, { status: 413 });
  const payload = parseJsonObject(new TextDecoder().decode(bytes));
  if (!payload) return Response.json({ error: "Invalid Teams activity" }, { status: 400 });
  try { await dependencies.verify(request, native.app, payload.serviceUrl); }
  catch (error) {
    if (error instanceof ProviderRequestError && error.status === 401) return Response.json({ error: "Teams authentication failed" }, { status: 401 });
    throw error;
  }
  const interaction = await teamsInteraction(payload, native.app);
  if (interaction.kind === "ignored") return Response.json({});
  const rooms = dependencies.rooms(env), base = { requestId: crypto.randomUUID(), app: native.app,
    chatSpace: interaction.chatSpace, eventTime: interaction.eventTime };
  if (interaction.kind === "removed") {
    await rooms.remove(base);
    return Response.json({});
  }
  if (interaction.kind === "link") {
    await native.client.member(interaction.reference);
    try { await rooms.confirm({ ...base, nonce: interaction.nonce, teamsReference: interaction.reference }); }
    catch (error) {
      if ([404, 409].includes((error as { status: number }).status)) return Response.json({ error: "Teams confirmation expired or changed" }, { status: 409 });
      throw error;
    }
    // Human sees the durable result in Apps; no untracked proactive welcome writes on provider retry.
    return Response.json({});
  }
  if (interaction.kind === "member-removed") {
    const binding = await rooms.route(base);
    if (binding?.teamsReference && interaction.users.includes(binding.teamsReference.userId)) await rooms.remove(base);
    return Response.json({});
  }
  if (interaction.kind !== "message") return Response.json({});
  await deliverConnectorRoom(env, rooms, base, interaction.event,
    { provider: "teams", appIdentity: teamsAppIdentity(native.app) }, dependencies);
  return Response.json({});
}
