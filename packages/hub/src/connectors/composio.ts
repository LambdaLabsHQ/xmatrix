import { record } from "./command-support";
import { providerJson, ProviderRequestError } from "./http";

/*
 * Composio-hosted sign-in and API calls for providers whose OAuth app is
 * Composio's (docs/design/connector-platform.md). The provider's
 * `CONNECTOR_<ID>_CLIENT_ID` is its Composio auth config id; every such
 * provider shares the Composio project key `CONNECTOR_COMPOSIO_API_KEY`. Each connect attempt gets its
 * own Composio user id derived from the signed state, so the account the Hub
 * stores is the one this admin's attempt created, never one named by a
 * redirect parameter. Every proxied call names that account; Composio's
 * project-default account is never used.
 */

const API = "https://backend.composio.dev/api/v3.1";
const ACCOUNT_ID = /^[A-Za-z0-9_-]{4,128}$/u;

interface ComposioClient { clientId: string; clientSecret: string; manifest: { id: string; name: string } }

function apiHeaders(apiKey: string): Record<string, string> {
  if (!apiKey || apiKey.length > 512 || /\s/u.test(apiKey)) throw new ProviderRequestError(503, "Composio is not configured on this Hub");
  return { "x-api-key": apiKey };
}

/** The Composio user id one connect attempt signs in as. */
export function composioUserId(spaceId: string, nonce: string): string {
  return `xmatrix:${spaceId}:${nonce}`;
}

/** Starts Composio's hosted sign-in; it returns to `callbackUrl` with the state still on it. */
export async function composioConnectUrl(client: ComposioClient, userId: string, callbackUrl: string): Promise<string> {
  const link = await providerJson(`${API}/connected_accounts/link`, { method: "POST", headers: apiHeaders(client.clientSecret),
    json: { auth_config_id: client.clientId, user_id: userId, callback_url: callbackUrl } });
  const url = typeof link.redirect_url === "string" ? link.redirect_url : "";
  if (!url.startsWith("https://")) throw new ProviderRequestError(502, `Composio did not start ${client.manifest.name} sign-in`);
  return url;
}

/** The one active account this attempt's user id holds under the configured auth config. */
export async function composioConnectedAccount(client: ComposioClient, userId: string): Promise<string> {
  const url = new URL(`${API}/connected_accounts`);
  url.searchParams.set("user_ids", userId);
  url.searchParams.set("auth_config_ids", client.clientId);
  url.searchParams.set("statuses", "ACTIVE");
  url.searchParams.set("limit", "2");
  const result = await providerJson(url, { headers: apiHeaders(client.clientSecret) });
  const items = Array.isArray(result.items) ? result.items.map(record) : [];
  const id = items.length === 1 && record(items[0]!.auth_config).id === client.clientId ? items[0]!.id : undefined;
  if (typeof id !== "string" || !ACCOUNT_ID.test(id)) {
    throw new ProviderRequestError(400, `Composio did not confirm the ${client.manifest.name} sign-in; restart Connect`);
  }
  return id;
}

/** One GET to the provider's API through Composio as the stored account; returns the provider's JSON. */
export async function composioGet(credentials: Readonly<Record<string, string>>, endpoint: string,
  query: Record<string, string | string[]> = {}): Promise<Record<string, unknown>> {
  const account = credentials.composioAccountId ?? "";
  if (!ACCOUNT_ID.test(account)) throw new ProviderRequestError(401, "Connect with Composio first");
  const parameters = Object.entries(query).flatMap(([name, values]) =>
    (Array.isArray(values) ? values : [values]).map(value => ({ name, value, type: "query" })));
  const result = await providerJson(`${API}/tools/execute/proxy`, { method: "POST", headers: apiHeaders(credentials.composioApiKey ?? ""),
    json: { connected_account_id: account, endpoint, method: "GET", parameters } });
  const status = Number(result.status);
  if (!Number.isInteger(status)) throw new ProviderRequestError(502, "Composio did not return the provider's answer");
  if (status < 200 || status > 299) {
    const message = record(record(result.data).error).message;
    throw new ProviderRequestError(status, typeof message === "string" ? message.slice(0, 200) : `the provider answered ${status}`);
  }
  return record(result.data);
}

/** Deletes a connected account and the Google grant Composio holds for it; one already gone counts as deleted. */
export async function deleteComposioAccount(apiKey: string, accountId: string): Promise<void> {
  if (!ACCOUNT_ID.test(accountId)) return;
  await providerJson(`${API}/connected_accounts/${accountId}`, { method: "DELETE", headers: apiHeaders(apiKey) })
    .catch((error: unknown) => { if (!(error instanceof ProviderRequestError && error.status === 404)) throw error; });
}
