import { telegramChatId } from "@xmatrix/db";
import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Hono } from "hono";
import type { Env } from "./types";
import { registerGroupLinkRoutes } from "./index-routes-group-link";
import { connectorTelegramRoomRepository } from "./connectors/credentials";
import { telegramNativeApp, telegramBotClient, telegramSource } from "./connectors/telegram-native";
import { ProviderRequestError } from "./connectors/http";

export function registerTelegramRoutes(app: Hono<{ Bindings: Env }>): void {
  registerGroupLinkRoutes(app, { provider: "telegram", label: "Telegram",
    path: HUB_ROUTES.space_app_connection_telegram_link, native: telegramNativeApp,
    rooms: connectorTelegramRoomRepository, source: telegramSource,
    selection(payload) {
      if (typeof payload.chatId !== "string" || Object.keys(payload).some(key => key !== "chatId")) {
        throw new ProviderRequestError(400, "Choose a Telegram group");
      }
      return telegramChatId(payload.chatId);
    },
    async getChat(env, native, chatSpace) { return { botUsername: (await telegramBotClient(env, native).getChat(chatSpace)).username }; },
  });
}
