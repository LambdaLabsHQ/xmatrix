import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import type { Env } from "./types";
import { registerGroupLinkRoutes } from "./index-routes-group-link";
import { connectorFeishuRoomRepository } from "./connectors/credentials";
import { feishuNativeApp, feishuStoreClient, feishuRoom, feishuSource } from "./connectors/feishu-native";
import { ProviderRequestError } from "./connectors/http";

export function registerFeishuRoutes(app: Hono<{ Bindings: Env }>): void {
  registerGroupLinkRoutes(app, { provider: "feishu", label: "Feishu",
    path: HUB_ROUTES.space_app_connection_feishu_link, native: feishuNativeApp,
    rooms: connectorFeishuRoomRepository, source: feishuSource,
    selection(payload) {
      if (typeof payload.tenantKey !== "string" || typeof payload.chatId !== "string" || Object.keys(payload).some(key => !["tenantKey", "chatId"].includes(key))) {
        throw new ProviderRequestError(400, "Choose a Feishu tenant and group");
      }
      return feishuRoom(payload.tenantKey, payload.chatId);
    },
    async getChat(env, native, chatSpace) { await feishuStoreClient(env, native).getChat(chatSpace); return {}; },
  });
}
