import { ControlError, type PostgresAppCredentialRepository, type ResolvedAppCredentials } from "@xmatrix/db";
import type { Env } from "../types";
import { getChannel } from "../spaces";
import { record } from "./command-support";
import { connectorCredentialRepository } from "./credentials";
import { ProviderRequestError } from "./http";
import { oauthClient, type OAuthClient } from "./oauth";
import { parseXAccounts, xAccountFields, type XAccount, type XAccountView, type XActionCapability } from "./x-accounts";
import { xProviderJson, xTokenGrant } from "./x-oauth";

type Store = Pick<PostgresAppCredentialRepository, "resolve" | "put">;
const view = ({ id, username, generation }: XAccount): XAccountView => ({ id, username, generation });

function selected(stored: ResolvedAppCredentials | null, account: XAccountView): XAccount {
  const found = parseXAccounts(stored?.values.accounts).find(a => a.id === account.id && a.generation === account.generation);
  if (!found) throw new ProviderRequestError(409, "The X account was disconnected or reconnected; create a new request");
  return found;
}

/** A bounded CAS merge preserves other accounts and fences disconnect/recreate and reauthorization. */
async function updateAccount(store: Store, spaceId: string, account: XAccountView,
  change: (account: XAccount) => XAccount): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await store.resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "x" });
    const current = selected(stored, account);
    const next = change(current);
    try {
      await store.put({ requestId: crypto.randomUUID(), spaceId, providerId: "x", actorUserId: "hub:x-token-refresh",
        fields: xAccountFields(parseXAccounts(stored!.values.accounts).map(a => a.id === current.id ? next : a)),
        policy: { allowed: ["accounts"] }, at: new Date().toISOString(), asHub: true,
        expectedVersion: stored!.version, expectedGrant: stored! });
      return;
    } catch (error) {
      if (!(error instanceof ControlError) || error.code !== "credential_changed" || attempt === 2) throw error;
    }
  }
}

/**
 * Claim a durable lease BEFORE asking X to rotate. A rival never sends a second
 * refresh. A lost/uncertain response leaves the lease closed until reconnect;
 * a confirmed pair is merged without repeating the provider request.
 */
export async function refreshXAccount(store: Store, spaceId: string, client: OAuthClient, account: XAccountView): Promise<XAccount> {
  const read = () => store.resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "x" });
  let current = selected(await read(), account);
  if (current.needsReconnect) throw new ProviderRequestError(401, "Reconnect this X account before using it");
  if (current.clientId !== client.clientId || current.scopes !== client.manifest.oauth.scopes.join(" ")) {
    throw new ProviderRequestError(401, "The X company application changed; reconnect this account");
  }
  if (current.refreshing) throw new ProviderRequestError(409, Date.now() - (current.refreshStartedAt ?? 0) > 30_000
    ? "The last X token refresh could not be confirmed; reconnect this account" : "This X account is refreshing; try again shortly");
  if (current.expiresAt > Date.now() + 30_000) return current;
  const lease = crypto.randomUUID();
  await updateAccount(store, spaceId, account, a => {
    if (a.refreshing || a.refreshToken !== current.refreshToken) throw new ProviderRequestError(409, "This X grant changed during refresh; try again");
    return { ...a, refreshing: lease, refreshStartedAt: Date.now() };
  });
  // Never catch a timeout and retry this request: X may already have rotated.
  const payload = await xProviderJson("/2/oauth2/token", { method: "POST",
    headers: { authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken }) });
  const tokens = xTokenGrant(client, payload, current);
  await updateAccount(store, spaceId, account, a => {
    if (a.refreshing !== lease) throw new ProviderRequestError(409, "This X grant changed while saving its refresh; reconnect");
    const { refreshing: _lease, refreshStartedAt: _started, ...kept } = a;
    return { ...kept, ...tokens };
  });
  current = selected(await read(), account);
  return current;
}

function allowedPath(account: XAccountView, method: "GET" | "POST", path: string): boolean {
  if (method === "POST") return path === "/2/tweets" || path === "/2/media/upload/initialize" ||
    /^\/2\/media\/upload\/[1-9][0-9]{0,19}\/(?:append|finalize)$/u.test(path);
  return path === "/2/users/me" || /^\/2\/tweets\/[1-9][0-9]{0,19}\?tweet\.fields=author_id,created_at$/u.test(path) ||
    path === `/2/users/${account.id}/tweets?max_results=10&tweet.fields=author_id,created_at` ||
    /^\/2\/media\/upload\?command=STATUS&media_id=[1-9][0-9]{0,19}$/u.test(path);
}

export function xActionCapability(env: Env, input: { spaceId: string; channelId: string; actorUserId: string;
  authorizeWrite: () => Promise<void> }): XActionCapability {
  const store = connectorCredentialRepository(env);
  const live = async () => {
    const { channel } = await getChannel(env, { channelId: input.channelId, principal: { kind: "user", id: input.actorUserId } });
    if (record(channel).spaceId !== input.spaceId) throw new ProviderRequestError(403, "The X Channel access changed");
    const stored = await store.resolve({ requestId: crypto.randomUUID(), spaceId: input.spaceId, providerId: "x" });
    if (stored?.status !== "configured") throw new ProviderRequestError(409, "Connect X to this Space first");
    return stored;
  };
  return {
    accounts: async () => parseXAccounts((await live()).values.accounts).filter(a => a.ownerUserId === input.actorUserId).map(view),
    request: async (account, method, path, body) => {
      if (!allowedPath(account, method, path)) throw new ProviderRequestError(403, "This X API endpoint is unavailable");
      let current = selected(await live(), account);
      if (current.ownerUserId !== input.actorUserId) throw new ProviderRequestError(403, "This X account belongs to another member");
      const client = oauthClient(env, "x");
      if (!client) throw new ProviderRequestError(503, "The X company app is not configured");
      await refreshXAccount(store, input.spaceId, client, account);
      if (method === "POST") await input.authorizeWrite();
      current = selected(await live(), account);
      if (current.ownerUserId !== input.actorUserId || current.refreshing || current.expiresAt <= Date.now()) {
        throw new ProviderRequestError(409, "This X account grant changed before the request");
      }
      try {
        return await xProviderJson(path, { method, headers: { authorization: `Bearer ${current.accessToken}` },
          ...(body ? { json: body } : {}) });
      } catch (error) {
        if (error instanceof ProviderRequestError && error.status === 401) {
          await updateAccount(store, input.spaceId, account, a => ({ ...a, needsReconnect: true }));
        }
        throw error;
      }
    },
  };
}

/** Check uses each account's own grant, refreshing it through the same durable fence. */
export async function verifyXConnection(env: Env, spaceId: string): Promise<void> {
  const store = connectorCredentialRepository(env), client = oauthClient(env, "x");
  if (!client) throw new ProviderRequestError(503, "The X company app is not configured");
  const stored = await store.resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "x" });
  const accounts = parseXAccounts(stored?.values.accounts);
  if (!accounts.length) throw new ProviderRequestError(401, "Connect an X account first");
  let working = 0, failure: unknown;
  for (const account of accounts) {
    try {
      const current = await refreshXAccount(store, spaceId, client, account);
      const result = record((await xProviderJson("/2/users/me", { headers: { authorization: `Bearer ${current.accessToken}` } })).data);
      if (result.id !== account.id) throw new ProviderRequestError(401, "X did not confirm the selected account");
      working++;
    } catch (error) {
      failure = error;
      if (error instanceof ProviderRequestError && error.status === 401) {
        await updateAccount(store, spaceId, account, a => ({ ...a, needsReconnect: true }));
      }
    }
  }
  if (!working) throw failure;
}
