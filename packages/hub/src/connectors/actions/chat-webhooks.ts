import { hmacBytes } from "@xmatrix/protocol";
import { providerJson, providerUrl, ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionStatement } from "../provider";
import { requireText } from "./common";

/*
 * Chat tools that take messages through a bot or incoming-webhook URL. A
 * configured URL is accepted only on the provider's own hosts, so a stored
 * credential cannot point an action at an arbitrary server.
 */

function hostedUrl(value: string | undefined, hosts: readonly RegExp[], name: string): URL {
  const url = providerUrl(value ?? "");
  if (!hosts.some((host) => host.test(url.hostname))) {
    throw new ProviderRequestError(400, `${name} webhook URL must be on ${name}'s own host`);
  }
  return url;
}

function textOnly(statement: ConnectorActionStatement, usage: string): Record<string, string> | string {
  const value = [statement.target, statement.text].filter(Boolean).join(" ").trim();
  return value ? { text: value.slice(0, 4_000) } : `write the message: ${usage}`;
}

function telegramBotToken(credentials: Readonly<Record<string, string>>): string {
  const token = credentials.botToken ?? "";
  if (!/^\d{5,16}:[A-Za-z0-9_-]{20,64}$/u.test(token)) {
    throw new ProviderRequestError(400, "Telegram bot token is malformed");
  }
  return token;
}

/** getMe verifies the bot without posting or changing its webhook. */
export async function verifyTelegram(credentials: Readonly<Record<string, string>>): Promise<void> {
  const response = await providerJson(`https://api.telegram.org/bot${telegramBotToken(credentials)}/getMe`);
  const bot = response.result as { id?: unknown; is_bot?: unknown } | undefined;
  if (response.ok !== true || !bot || bot.is_bot !== true || !Number.isSafeInteger(bot.id) || Number(bot.id) <= 0) {
    throw new ProviderRequestError(401, "Telegram did not confirm the bot credentials");
  }
}

export const TELEGRAM_ACTIONS: Record<string, ConnectorAction> = {
  send: {
    effect: "write",
    requires: ["botToken"],
    parse(statement) {
      if (!/^-?\d{1,20}$/u.test(statement.target)) return "name a chat id: @telegram:send:-1001234567890 <text>";
      const text = requireText(statement);
      return text ? { chat: statement.target, text } : "write the message after the chat id";
    },
    async execute({ credentials, telegram }, input) {
      if (telegram) {
        await telegram.sendMessage(input.chat!, input.text!);
        return { summary: `Sent to the connected Telegram group ${input.chat}` };
      }
      const sent = await providerJson(`https://api.telegram.org/bot${telegramBotToken(credentials)}/sendMessage`, {
        method: "POST", json: { chat_id: input.chat, text: input.text } });
      if (sent.ok !== true) throw new ProviderRequestError(400, `Telegram refused the message: ${String(sent.description ?? "")}`);
      return { summary: `Sent to Telegram chat ${input.chat}` };
    },
  },
};

const TEAMS_HOSTS = [/\.webhook\.office\.com$/u, /\.logic\.azure\.com$/u, /\.api\.powerplatform\.com$/u];

export const TEAMS_ACTIONS: Record<string, ConnectorAction> = {
  post: {
    effect: "write",
    requires: ["webhookUrl"],
    parse: (statement) => textOnly(statement, "@teams:post <text>"),
    async execute({ credentials, teams }, input) {
      if (teams) {
        await teams.postMessage(input.text!);
        return { summary: "Posted to the connected Teams conversation" };
      }
      await providerJson(hostedUrl(credentials.webhookUrl, TEAMS_HOSTS, "Microsoft Teams"), { method: "POST",
        json: { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: {
          type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text: input.text, wrap: true }] } }] } });
      return { summary: "Posted to Microsoft Teams" };
    },
  },
};

export const GOOGLE_CHAT_ACTIONS: Record<string, ConnectorAction> = {
  post: {
    effect: "write",
    requires: ["webhookUrl"],
    parse: (statement) => textOnly(statement, "@googlechat:post <text>"),
    async execute({ credentials, googleChat }, input) {
      if (googleChat) {
        await googleChat.postMessage(input.text!);
        return { summary: "Posted to the connected Google Chat space" };
      }
      await providerJson(hostedUrl(credentials.webhookUrl, [/^chat\.googleapis\.com$/u], "Google Chat"), {
        method: "POST", json: { text: input.text } });
      return { summary: "Posted to Google Chat" };
    },
  },
};

export const DINGTALK_ACTIONS: Record<string, ConnectorAction> = {
  read: {
    effect: "read", requires: [],
    parse(statement) {
      return /^member-[a-f0-9]{64}$/u.test(statement.target) && !statement.text
        ? { recipient: statement.target } : "copy one confirmed member recipient from Apps → DingTalk";
    },
    async execute({ dingtalk }, input) {
      if (!dingtalk) throw new ProviderRequestError(409, "A confirmed DingTalk company is required");
      const member = await dingtalk.readMember(input.recipient!);
      return { summary: JSON.stringify({ memberId: member.memberId, name: member.name, active: member.active }) };
    },
  },
  send: {
    effect: "write", requires: [],
    parse(statement) {
      if (!/^member-[a-f0-9]{64}$/u.test(statement.target)) return "copy one confirmed member recipient from Apps → DingTalk";
      const text = requireText(statement);
      return text ? { recipient: statement.target, text } : "write the notification after the recipient";
    },
    async execute({ dingtalk }, input) {
      if (!dingtalk) throw new ProviderRequestError(409, "A confirmed DingTalk company is required");
      const accepted = await dingtalk.sendMessage(input.recipient!, input.text!);
      return { summary: `${accepted.summary} (task ${accepted.taskId})` };
    },
  },
  post: {
    effect: "write",
    requires: ["accessToken"],
    parse: (statement) => textOnly(statement, "@dingtalk:post <text>"),
    async execute({ credentials }, input) {
      const url = new URL("https://oapi.dingtalk.com/robot/send");
      url.searchParams.set("access_token", credentials.accessToken!);
      if (credentials.signSecret) {
        const timestamp = String(Date.now());
        const signature = await hmacBytes("SHA-256", credentials.signSecret, `${timestamp}\n${credentials.signSecret}`);
        url.searchParams.set("timestamp", timestamp);
        url.searchParams.set("sign", btoa(String.fromCharCode(...signature)));
      }
      const sent = await providerJson(url, { method: "POST", json: { msgtype: "text", text: { content: input.text } } });
      if (sent.errcode !== 0) throw new ProviderRequestError(400, `DingTalk refused the message: ${String(sent.errmsg ?? sent.errcode)}`);
      return { summary: "Posted to DingTalk" };
    },
  },
};

export const WECOM_ACTIONS: Record<string, ConnectorAction> = {
  send: {
    effect: "write", requires: [],
    parse(statement) {
      if (!/^member-[a-f0-9]{64}$/u.test(statement.target)) return "copy a confirmed member recipient from Apps → WeCom";
      const text = requireText(statement);
      return text ? { recipient: statement.target, text } : "write the message after the recipient";
    },
    async execute({ wecom }, input) {
      if (!wecom) throw new ProviderRequestError(409, "A confirmed WeCom company installation is required");
      await wecom.sendMessage(input.recipient!, input.text!);
      return { summary: "Sent to the confirmed WeCom member" };
    },
  },
  post: {
    effect: "write",
    requires: ["webhookKey"],
    parse: (statement) => textOnly(statement, "@wecom:post <text>"),
    async execute({ credentials }, input) {
      const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/webhook/send");
      url.searchParams.set("key", credentials.webhookKey!);
      const sent = await providerJson(url, { method: "POST", json: { msgtype: "text", text: { content: input.text } } });
      if (sent.errcode !== 0) throw new ProviderRequestError(400, `WeCom refused the message: ${String(sent.errmsg ?? sent.errcode)}`);
      return { summary: "Posted to WeCom" };
    },
  },
};
