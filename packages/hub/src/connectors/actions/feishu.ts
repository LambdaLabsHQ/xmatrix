import { providerJson, ProviderRequestError } from "../http";
import { feishuApiUrl, feishuTenantToken } from "../feishu-api";
import type { ConnectorAction } from "../provider";
import { requireText } from "./common";

const CHAT = /^oc_[A-Za-z0-9]{4,64}$/u;

export const FEISHU_ACTIONS: Record<string, ConnectorAction> = {
  send: {
    effect: "write",
    requires: ["appId", "appSecret"],
    parse(statement) {
      if (!CHAT.test(statement.target)) return "name a chat id: @feishu:send:oc_… <text>";
      const text = requireText(statement);
      return text ? { chat: statement.target, text } : "write the message after the chat id";
    },
    async execute({ credentials, feishu }, input) {
      if (feishu) { await feishu.sendMessage(input.chat!, input.text!); return { summary: `Sent to Feishu chat ${input.chat}` }; }
      const token = await feishuTenantToken(credentials);
      const sent = await providerJson(feishuApiUrl(credentials, "im/v1/messages?receive_id_type=chat_id"), { method: "POST",
        headers: { authorization: `Bearer ${token}` },
        json: { receive_id: input.chat, msg_type: "text", content: JSON.stringify({ text: input.text }) } });
      if (sent.code !== 0) throw new ProviderRequestError(400, `Feishu refused the message: ${String(sent.msg ?? sent.code)}`);
      return { summary: `Sent to Feishu chat ${input.chat}` };
    },
  },
};
