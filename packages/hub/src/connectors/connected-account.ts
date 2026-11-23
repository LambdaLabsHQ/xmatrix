import { bingConnectedAccount } from "./actions/bing-webmaster";
import { linear, linearRecord } from "./actions/linear-api";
import { providerJson } from "./http";
import type { ProviderEgress } from "./provider-egress";

/*
 * The account a connection reached, as the person who connected it would name
 * it: a Google address, a Linear or Slack workspace, a Notion workspace, how
 * many Bing sites. It is read on every passed Check and kept on the connection
 * so its page can say which account is connected; a person picking Switch
 * account sees what they are switching from. Only a name is kept, never
 * profile data, and reading it never decides whether the Check passes.
 */

type Credentials = Readonly<Record<string, string>>;
type Identify = (credentials: Credentials, egress?: ProviderEgress) => Promise<string | undefined>;

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;

/** The Google account's address; grants made before the identity scopes were requested have none. */
const google: Identify = async (credentials) => {
  if (!credentials.oauthToken) return undefined;
  const user = await providerJson("https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { authorization: `Bearer ${credentials.oauthToken}` } });
  return text(user.email);
};

const IDENTIFY: Record<string, Identify> = {
  ...Object.fromEntries(["google", "googlesearchconsole", "googleadsense", "googlecalendar", "googleanalytics", "googleads",
    "googlebusinessprofile", "gcp", "googleplay"].map((id) => [id, google])),
  linear: async (credentials) => {
    if (!credentials.oauthToken && !credentials.apiKey) return undefined;
    const data = await linear(credentials, "query { organization { name } }", {});
    return text(linearRecord(data.organization).name);
  },
  slack: async (credentials) => {
    if (!credentials.botToken) return undefined;
    const team = await providerJson("https://slack.com/api/auth.test", { method: "POST",
      headers: { authorization: `Bearer ${credentials.botToken}` } });
    return team.ok === true ? text(team.team) : undefined;
  },
  notion: async (credentials) => {
    if (!credentials.integrationToken) return undefined;
    const me = await providerJson("https://api.notion.com/v1/users/me",
      { headers: { authorization: `Bearer ${credentials.integrationToken}`, "notion-version": "2022-06-28" } });
    return text((me.bot as { workspace_name?: unknown } | undefined)?.workspace_name);
  },
  bingwebmaster: bingConnectedAccount,
};

/** The name of the account this connection reached, or undefined when the provider names none or the read failed. */
export async function connectedAccount(providerId: string, credentials: Credentials, egress?: ProviderEgress):
  Promise<string | undefined> {
  try {
    return await IDENTIFY[providerId]?.(credentials, egress);
  } catch {
    return undefined;
  }
}

/** Whether this provider names the account a connection reached. */
export function hasConnectedAccount(providerId: string): boolean {
  return providerId in IDENTIFY;
}
