import { googleChatAppIdentity } from "@xmatrix/db";
import { readBoundedRequestBody } from "../index-shared";
import type { Env } from "../types";
import { connectorGoogleChatRoomRepository, connectorAppRepository } from "./credentials";
import { CONNECTOR_DELIVERY_EFFECTS, deliverEvent, deliverConnectorRoom } from "./event-ingress";
import { parseJsonObject } from "./event-format";
import { googleChatNativeApp } from "./googlechat-native";
import { googleChatInteraction, googleChatResponse } from "./googlechat-events";
import { verifyGoogleChatAddonRequest } from "./googlechat-app-auth";
import { ProviderRequestError } from "./http";

export const GOOGLECHAT_INGRESS_DEPENDENCIES = {
  native: googleChatNativeApp, rooms: connectorGoogleChatRoomRepository, apps: connectorAppRepository,
  verify: verifyGoogleChatAddonRequest, deliver: deliverEvent, append: CONNECTOR_DELIVERY_EFFECTS.append,
  automate: CONNECTOR_DELIVERY_EFFECTS.automations,
};
/** One configured HTTP add-on endpoint; no caller-supplied xMatrix Space or alternate token audience. */
export async function handleGoogleChatAppDelivery(env: Env, request: Request,
  dependencies = GOOGLECHAT_INGRESS_DEPENDENCIES): Promise<Response> {
  const native = dependencies.native(env);
  if (!native) return Response.json({ error: "Google Chat app is not configured" }, { status: 503 });
  const origin = env.HUB_URL?.trim().replace(/\/+$/u, "");
  if (!origin) return Response.json({ error: "Google Chat endpoint is not configured" }, { status: 503 });
  try {
    await dependencies.verify(request, { endpoint: origin + "/api/connectors/googlechat/events",
      systemServiceAccountEmail: native.app.systemServiceAccountEmail });
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 401) {
      return Response.json({ error: "Google Chat request authentication failed" }, { status: 401 });
    }
    throw error;
  }
  const bytes = await readBoundedRequestBody(request, 32 * 1024);
  if (!bytes) return Response.json({ error: "Google Chat interaction is too large" }, { status: 413 });
  const payload = parseJsonObject(new TextDecoder().decode(bytes));
  if (!payload) return Response.json({ error: "Invalid Google Chat interaction" }, { status: 400 });
  const interaction = await googleChatInteraction(payload);
  if (!interaction) return Response.json({});
  const rooms = dependencies.rooms(env), base = { requestId: crypto.randomUUID(), app: native.app,
    chatSpace: interaction.chatSpace, eventTime: interaction.eventTime };
  if (interaction.kind === "added") return googleChatResponse("In xMatrix Apps, choose Google Chat and link this space.");
  if (interaction.kind === "removed") {
    await rooms.remove(base);
    return Response.json({});
  }
  if (interaction.kind === "invalid-link") return googleChatResponse("Use the confirmation shown in xMatrix Apps.");
  if (interaction.kind === "link") {
    try {
      // API membership check is read-only; only the primary authority can consume the challenge.
      await native.client.getSpace(interaction.chatSpace);
      await rooms.confirm({ ...base, nonce: interaction.nonce });
      return googleChatResponse("This Google Chat space is connected to xMatrix.");
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 409) return googleChatResponse("Confirmation expired or changed. Start again in xMatrix Apps.");
      throw error;
    }
  }
  if (interaction.kind !== "message") return Response.json({});
  await deliverConnectorRoom(env, rooms, base, interaction.event,
    { provider: "googlechat", appIdentity: googleChatAppIdentity(native.app) }, { ...dependencies, automations: dependencies.automate });
  // No acknowledgement before subscribed delivery succeeds; stable event ids make retries idempotent.
  return Response.json({});
}
