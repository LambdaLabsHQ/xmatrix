import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { requireText } from "./common";

const CHANNEL = /^[A-Z0-9]{6,24}$/u;
const THREAD = /^\d{6,12}\.\d{1,8}$/u;

/** `@slack:post:<channel id>[/<thread ts>] <text>` with the app's bot token. */
export const SLACK_ACTIONS: Record<string, ConnectorAction> = {
  post: {
    effect: "write",
    requires: ["botToken"],
    parse(statement) {
      const [channel = "", thread = ""] = statement.target.toUpperCase().split("/");
      if (!CHANNEL.test(channel)) return "name a Slack channel id: @slack:post:C0123456789 <text>";
      if (thread && !THREAD.test(thread)) return "a thread is the parent message ts, such as 1700000000.000100";
      const text = requireText(statement);
      if (!text) return "write the message after the channel id";
      return { channel, text, ...(thread ? { thread } : {}) };
    },
    async execute({ credentials }, input) {
      const payload = await providerJson("https://slack.com/api/chat.postMessage", { method: "POST",
        headers: { authorization: `Bearer ${credentials.botToken}` },
        json: { channel: input.channel, text: input.text, ...(input.thread ? { thread_ts: input.thread } : {}) } });
      if (payload.ok !== true) throw new ProviderRequestError(400, `Slack refused the message: ${String(payload.error ?? "unknown")}`);
      return { summary: `Posted to ${input.channel}${input.thread ? " (thread)" : ""}` };
    },
  },
};


/** Slack reports authentication failures in a successful HTTP response. */
export async function verifySlack(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (!credentials.botToken) return;
  const payload = await providerJson("https://slack.com/api/auth.test", {
    method: "POST", headers: { authorization: `Bearer ${credentials.botToken}` },
  });
  if (payload.ok !== true || typeof payload.team_id !== "string" || !payload.team_id) {
    throw new ProviderRequestError(401, "Slack did not authenticate the bot token");
  }
}
