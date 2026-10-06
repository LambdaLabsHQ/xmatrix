import { checkGroups } from "./group-check";
import { telegramAppIdentity, telegramChatId, type TelegramAppIdentity } from "@xmatrix/db";
import { sha256Hex, utf8ByteLength } from "@xmatrix/protocol";
import type { Env } from "../types";
import { connectorCredentialRepository, connectorTelegramRoomRepository } from "./credentials";
import { record } from "./event-format";
import { providerJson, providerUrl, ProviderRequestError } from "./http";
import type { ConnectorActionContext } from "./provider";

export async function telegramNativeApp(env: Env) {
  const vars = env as unknown as Record<string, unknown>;
  const token = vars.CONNECTOR_TELEGRAM_BOT_TOKEN, secret = vars.CONNECTOR_TELEGRAM_WEBHOOK_SECRET;
  if ((token === undefined || token === "") && (secret === undefined || secret === "")) return undefined;
  if (typeof token !== "string" || !/^[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,64}$/u.test(token) ||
      typeof secret !== "string" || !/^[A-Za-z0-9_-]{32,256}$/u.test(secret)) {
    throw new ProviderRequestError(503, "Telegram company bot is not configured");
  }
  const app: TelegramAppIdentity = { providerId: "telegram", botId: token.split(":")[0]!,
    eventKeyDigest: await sha256Hex(JSON.stringify([token, secret])) };
  try { telegramAppIdentity(app); } catch { throw new ProviderRequestError(503, "Telegram bot identity is invalid"); }
  // Updates do not identify the receiving bot. Fence even token-only rotation
  // with a separate domain-bound delivery secret; the stored app fingerprint
  // must never itself become an authentication credential.
  const deliverySecret = await sha256Hex(JSON.stringify(["xmatrix-telegram-webhook-v1", token, secret]));
  return { app, token, secret: deliverySecret };
}
export const TELEGRAM_NATIVE_DEPENDENCIES = { app: telegramNativeApp, rooms: connectorTelegramRoomRepository,
  credentials: connectorCredentialRepository, request: providerJson };
export type TelegramNative = NonNullable<Awaited<ReturnType<typeof telegramNativeApp>>>;
export function telegramSource(chatSpace: string): string { return `telegram:${telegramChatId(chatSpace)}`; }

/** Fixed official methods only; neither bot token nor arbitrary API access crosses the Hub boundary. */
export function telegramBotClient(env: Env, native: TelegramNative, dependencies = TELEGRAM_NATIVE_DEPENDENCIES) {
  const signal = AbortSignal.timeout(18_000);
  async function call(method: "getMe" | "getChat" | "getChatMember" | "getChatAdministrators" | "getWebhookInfo" | "sendMessage", json = {}): Promise<unknown> {
    try {
      const result = await dependencies.request(`https://api.telegram.org/bot${native.token}/${method}`, { method: "POST", json, signal });
      if (result.ok !== true || result.result === undefined) throw new Error("unconfirmed");
      return result.result;
    } catch { throw new ProviderRequestError(502, "Telegram did not confirm the request; check the group before retrying a write"); }
  }
  async function bot() {
    const user = record(await call("getMe"));
    if (user.is_bot !== true || !Number.isSafeInteger(user.id) || String(user.id) !== native.app.botId ||
        typeof user.username !== "string" || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(user.username)) {
      throw new ProviderRequestError(502, "Telegram returned a different bot identity");
    }
    return { id: Number(user.id), username: user.username };
  }
  async function group(chatSpace: string) {
    telegramChatId(chatSpace);
    const me = await bot(), chat = record(await call("getChat", { chat_id: chatSpace }));
    if (!Number.isSafeInteger(chat.id) || String(chat.id) !== chatSpace || !["group", "supergroup"].includes(String(chat.type))) {
      throw new ProviderRequestError(403, "Choose a Telegram group containing xMatrix");
    }
    const member = record(await call("getChatMember", { chat_id: chatSpace, user_id: me.id })), user = record(member.user);
    if (user.id !== me.id || user.is_bot !== true ||
        !(["member", "administrator"].includes(String(member.status)) || member.status === "restricted" && member.is_member === true && member.can_send_messages === true)) {
      throw new ProviderRequestError(403, "Add the xMatrix bot to this Telegram group with permission to send messages");
    }
    if (member.status !== "administrator" && record(chat.permissions).can_send_messages === false) {
      throw new ProviderRequestError(403, "The xMatrix bot cannot send messages to this group");
    }
    return me;
  }
  return {
    bot,
    getChat: group,
    async confirmAdministrator(chatSpace: string, userId: number, username: string) {
      const me = await group(chatSpace);
      if (me.username.toLowerCase() !== username.toLowerCase() || !Number.isSafeInteger(userId) || userId <= 0) {
        throw new ProviderRequestError(403, "Use the confirmation command addressed to this bot");
      }
      const admins = await call("getChatAdministrators", { chat_id: chatSpace });
      if (!Array.isArray(admins) || admins.length > 200 || !admins.some(value => {
        const member = record(value), user = record(member.user);
        return user.id === userId && user.is_bot === false && ["creator", "administrator"].includes(String(member.status));
      })) throw new ProviderRequestError(403, "A Telegram group administrator must send the confirmation");
    },
    async webhook() {
      let expected: string;
      try { expected = new URL("/api/connectors/telegram/events", providerUrl(env.HUB_URL ?? "")).href; }
      catch { throw new ProviderRequestError(503, "The Telegram webhook origin is not configured"); }
      const info = record(await call("getWebhookInfo"));
      const updates = info.allowed_updates;
      if (info.url !== expected || !Array.isArray(updates) || updates.length !== 2 ||
          !updates.includes("message") || !updates.includes("my_chat_member")) {
        throw new ProviderRequestError(409, "Configure the company bot webhook and its message/membership updates before checking");
      }
    },
    async sendMessage(chatSpace: string, text: string, beforeWrite: () => Promise<void>) {
      if (!text.trim() || utf8ByteLength(text) > 4000 || [...text].some(character => {
        const code = character.charCodeAt(0); return code === 127 || code < 32 && ![9, 10, 13].includes(code);
      })) throw new ProviderRequestError(400, "Write a Telegram message up to 4000 bytes");
      await group(chatSpace);
      await beforeWrite();
      signal.throwIfAborted();
      const sent = record(await call("sendMessage", { chat_id: chatSpace, text, link_preview_options: { is_disabled: true } }));
      if (!Number.isSafeInteger(sent.message_id) || Number(sent.message_id) <= 0 ||
          String(record(sent.chat).id) !== chatSpace || sent.text !== text) {
        throw new ProviderRequestError(502, "Telegram returned no matching message receipt; check before retrying");
      }
    },
  };
}

export async function telegramActionCapability(env: Env, spaceId: string, authorize: () => Promise<void>, dependencies = TELEGRAM_NATIVE_DEPENDENCIES): Promise<ConnectorActionContext["telegram"] | undefined> {
  const native = await dependencies.app(env);
  if (!native) return undefined;
  if (await dependencies.credentials(env).resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "telegram" }) !== null) return undefined;
  const rooms = dependencies.rooms(env), captured = await rooms.list({ requestId: crypto.randomUUID(), app: native.app, spaceId });
  if (!captured.length) throw new ProviderRequestError(409, "Link a Telegram group in Apps before sending");
  const client = telegramBotClient(env, native, dependencies);
  return { async sendMessage(chatSpace, text) {
    telegramChatId(chatSpace);
    const binding = captured.find(value => value.chatSpace === chatSpace);
    if (!binding) throw new ProviderRequestError(403, "Choose a Telegram group linked to this Space");
    const current = async () => {
      if (!await rooms.current({ requestId: crypto.randomUUID(), app: native.app, binding })) throw new ProviderRequestError(409, "Telegram group authorization changed; reconnect");
      await authorize();
    };
    await current();
    await client.sendMessage(chatSpace, text, current);
  } };
}
export async function verifyTelegramNativeConnection(env: Env, spaceId: string, dependencies = TELEGRAM_NATIVE_DEPENDENCIES): Promise<boolean> {
  const native = await dependencies.app(env);
  if (!native) return false;
  if (await dependencies.credentials(env).resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "telegram" }) !== null) return false;
  const rooms = dependencies.rooms(env), captured = await rooms.list({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
  if (!captured.length) throw new ProviderRequestError(409, "Link an active Telegram group before checking");
  const client = telegramBotClient(env, native, dependencies);
  await client.webhook();
  await checkGroups(captured, async binding => {
      await client.getChat(binding.chatSpace);
      const live = await rooms.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, chatSpace: binding.chatSpace, forCheck: true });
      if (!live || live.grantGeneration !== binding.grantGeneration) throw new ProviderRequestError(409, "Telegram authorization changed during Check");
  });
  return true;
}
