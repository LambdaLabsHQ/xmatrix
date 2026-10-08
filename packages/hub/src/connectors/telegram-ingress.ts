import { telegramAppIdentity } from "@xmatrix/db";
import { readBoundedRequestBody } from "../index-shared";
import type { Env } from "../types";
import { connectorAppRepository, connectorTelegramRoomRepository } from "./credentials";
import { CONNECTOR_DELIVERY_EFFECTS, deliverEvent } from "./event-ingress";
import { telegramAppInteraction, verifyTelegramAppRequest } from "./telegram-app-events";
import { telegramNativeApp, telegramBotClient } from "./telegram-native";
import { ProviderRequestError } from "./http";

export const TELEGRAM_INGRESS_DEPENDENCIES = { native: telegramNativeApp, rooms: connectorTelegramRoomRepository,
  apps: connectorAppRepository, client: telegramBotClient, deliver: deliverEvent,
  append: CONNECTOR_DELIVERY_EFFECTS.append, automate: CONNECTOR_DELIVERY_EFFECTS.automations };
export async function handleTelegramAppDelivery(env: Env, request: Request, dependencies = TELEGRAM_INGRESS_DEPENDENCIES): Promise<Response> {
  try {
    const native = await dependencies.native(env);
    if (!native) return Response.json({ error: "Telegram company bot is not configured" }, { status: 503 });
    await verifyTelegramAppRequest(native.secret, request.headers);
    const bytes = await readBoundedRequestBody(request, 32 * 1024);
    if (!bytes) return Response.json({ error: "Telegram update exceeds its bound" }, { status: 413 });
    const event = telegramAppInteraction(new TextDecoder().decode(bytes), native.app.botId);
    if (!event) return Response.json({ ok: true });
    const rooms = dependencies.rooms(env), base = { requestId: crypto.randomUUID(), app: native.app,
      chatSpace: event.chatSpace, eventTime: event.eventTime };
    if (event.kind === "removed") { await rooms.remove(base); return Response.json({ ok: true }); }
    if (event.kind === "link") {
      try {
        await dependencies.client(env, native).confirmAdministrator(event.chatSpace, event.userId, event.username);
        await rooms.confirm({ ...base, nonce: event.nonce });
      } catch (error) {
        if (![403, 404, 409].includes(Number((error as { status?: number }).status))) throw error;
      }
      return Response.json({ ok: true });
    }
    const binding = await rooms.route(base);
    if (!binding) return Response.json({ ok: true });
    const current = () => rooms.current({ requestId: crypto.randomUUID(), app: native.app, binding });
    if (!await current()) return Response.json({ ok: true });
    const append: typeof dependencies.append = async (...args) => await current() ? dependencies.append(...args) : new Response(null, { status: 503 });
    await dependencies.deliver(env, dependencies.apps(env), append, "telegram", binding.connectionId, event.event,
      undefined, undefined, undefined, { appIdentity: telegramAppIdentity(native.app), chatSpace: binding.chatSpace, grantGeneration: binding.grantGeneration });
    if (await current()) await dependencies.automate(env, { spaceId: binding.spaceId, provider: "telegram", event: event.event });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ProviderRequestError && [400, 401, 413].includes(error.status)) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Telegram app delivery is unavailable" }, { status: 503 });
  }
}
