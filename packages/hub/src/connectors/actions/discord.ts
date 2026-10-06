import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { requireText } from "./common";

const CHANNEL = /^\d{15,25}$/u;

/** `@discord:post:<channel id> <text>` with a bot token; mentions are not pinged. */
export const DISCORD_ACTIONS: Record<string, ConnectorAction> = {
  post: {
    effect: "write",
    requires: ["botToken|oauthToken"],
    parse(statement) {
      if (!CHANNEL.test(statement.target)) return "name a Discord channel id: @discord:post:123456789012345678 <text>";
      const text = requireText(statement);
      return text ? { channel: statement.target, text: text.slice(0, 2_000) } : "write the message after the channel id";
    },
    async execute({ credentials, discord }, input) {
      if (discord) {
        await discord.postMessage(input.channel!, input.text!);
        return { summary: `Posted to Discord channel ${input.channel}` };
      }
      if (credentials.oauthToken || !credentials.botToken) throw new ProviderRequestError(409, "Reconnect the Discord company bot");
      await providerJson(`https://discord.com/api/v10/channels/${input.channel}/messages`, { method: "POST",
        headers: { authorization: `Bot ${credentials.botToken}` },
        json: { content: input.text, allowed_mentions: { parse: [] } } });
      return { summary: `Posted to Discord channel ${input.channel}` };
    },
  },
};


/** Confirm the requester is a bot; no message or account profile is persisted. */
export async function verifyDiscord(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (!credentials.botToken) throw new ProviderRequestError(400, "Save the Discord bot token");
  const user = await providerJson("https://discord.com/api/v10/users/@me", {
    headers: { authorization: `Bot ${credentials.botToken}` } });
  if (typeof user.id !== "string" || !/^\d{15,25}$/u.test(user.id) || user.bot !== true) {
    throw new ProviderRequestError(401, "Discord did not confirm a bot account");
  }
}
