import { feishuAppIdentity } from "@xmatrix/db";
import { readBoundedRequestBody } from "../index-shared";
import type { Env } from "../types";
import { connectorFeishuAppRepository, connectorFeishuRoomRepository, connectorAppRepository } from "./credentials";
import { CONNECTOR_DELIVERY_EFFECTS, deliverEvent } from "./event-ingress";
import { verifyFeishuAppRequest, feishuAppInteraction } from "./feishu-app-events";
import { feishuNativeApp, feishuStoreClient } from "./feishu-native";
import { ProviderRequestError } from "./http";

export const FEISHU_INGRESS_DEPENDENCIES = { native: feishuNativeApp, authority: connectorFeishuAppRepository,
  rooms: connectorFeishuRoomRepository, apps: connectorAppRepository, client: feishuStoreClient,
  verify: verifyFeishuAppRequest, deliver: deliverEvent, append: CONNECTOR_DELIVERY_EFFECTS.append, automate: CONNECTOR_DELIVERY_EFFECTS.automations };
/** The shared company endpoint never accepts a caller-selected xMatrix Space or a self-built token fallback. */
export async function handleFeishuAppDelivery(env: Env, request: Request, dependencies = FEISHU_INGRESS_DEPENDENCIES): Promise<Response> {
  try {
    const native = await dependencies.native(env);
    if (!native) return Response.json({ error: "Feishu company app is not configured" }, { status: 503 });
    const bytes = await readBoundedRequestBody(request, 32 * 1024);
    if (!bytes) return Response.json({ error: "Feishu event exceeds its bound" }, { status: 413 });
    const payload = await dependencies.verify(native, new TextDecoder().decode(bytes), request.headers);
    if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge });
    const event = await feishuAppInteraction(payload);
    if (!event) return Response.json({ code: 0 });
    const base = { requestId: crypto.randomUUID(), app: native.app, eventId: event.eventId, eventTime: event.eventTime };
    const authority = dependencies.authority(env);
    if (event.kind === "ticket") { await authority.acceptTicket({ ...base, ticket: event.ticket }); return Response.json({ code: 0 }); }
    if (event.kind === "tenant") { await authority.applyTenant({ ...base, tenantKey: event.tenantKey, active: event.active }); return Response.json({ code: 0 }); }
    if (event.kind === "invalid-link") return Response.json({ code: 0 });
    const rooms = dependencies.rooms(env), room = { ...base, chatSpace: event.chatSpace };
    if (event.kind === "removed") { await rooms.remove(room); return Response.json({ code: 0 }); }
    if (event.kind === "link") {
      try {
        await dependencies.client(env, native).getChat(event.chatSpace);
        await rooms.confirm({ ...room, nonce: event.nonce });
      } catch (error) {
        if (![403, 404, 409].includes(Number((error as { status?: number }).status))) throw error;
      }
      return Response.json({ code: 0 });
    }
    if (event.kind !== "message") return Response.json({ code: 0 });
    const captured = await rooms.route(room);
    if (!captured) return Response.json({ code: 0 });
    const current = () => rooms.current({ requestId: crypto.randomUUID(), app: native.app, binding: captured });
    if (!await current()) return Response.json({ code: 0 });
    const append: typeof dependencies.append = async (...args) => await current() ? dependencies.append(...args) : new Response(null, { status: 503 });
    await dependencies.deliver(env, dependencies.apps(env), append, "feishu", captured.connectionId, event.event, undefined, undefined,
      { appIdentity: feishuAppIdentity(native.app), chatSpace: captured.chatSpace, grantGeneration: captured.grantGeneration });
    if (await current()) await dependencies.automate(env, { spaceId: captured.spaceId, provider: "feishu", event: event.event });
    return Response.json({ code: 0 });
  } catch (error) {
    if (error instanceof ProviderRequestError && [400, 401, 413].includes(error.status)) return Response.json({ error: error.message }, { status: error.status });
    // A failed authoritative commit or subscribed delivery must remain retryable; never log a provider payload or ticket.
    return Response.json({ error: "Feishu app delivery is unavailable" }, { status: 503 });
  }
}
