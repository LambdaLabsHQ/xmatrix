import { utf8ByteLength } from "@xmatrix/protocol";
import type { Env } from "../types";
import { connectorCredentialRepository } from "./credentials";
import { ProviderRequestError } from "./http";

/*
 * A Space's Cloudflare connection holds several OAuth logins
 * (docs/design/connector-platform.md, Cloudflare logins). Every Connect adds
 * one login; a Cloudflare user who connects again replaces their own login.
 * Each login keeps its own rotating grant and a snapshot of the accounts it
 * reached when it connected, for display only: which login serves an account
 * is decided live from Cloudflare on every call. The list lives only in the
 * connection's encrypted `logins` credential.
 */

export interface CloudflareAccountRef { id: string; name: string }
export interface CloudflareLogin {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accounts: CloudflareAccountRef[];
  connectedBy: string;
  connectedAt: string;
}
export interface CloudflareLoginView {
  id: string;
  accounts: CloudflareAccountRef[];
  connectedBy: string;
  connectedAt: string;
}

export const MAX_CLOUDFLARE_LOGINS = 5;
/* The snapshot is a label, not authority; it stays small so five logins fit one credential value. */
const SNAPSHOT_ACCOUNTS = 6;
const SNAPSHOT_NAME = 48;
const MAX_VALUE_BYTES = 8 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const ACCOUNT = /^[a-f0-9]{32}$/u;
const TOKEN = /^[\x21-\x7e]{1,2048}$/u;
const ACTOR = /^[A-Za-z0-9_.:-]{1,128}$/u;
const INVALID = "the stored Cloudflare logins are unreadable; reconnect Cloudflare";

function account(value: unknown): CloudflareAccountRef | undefined {
  const { id, name } = (value ?? {}) as Record<string, unknown>;
  if (typeof id !== "string" || !ACCOUNT.test(id) || typeof name !== "string" || name.length > SNAPSHOT_NAME) return undefined;
  return { id, name };
}

/** The stored list; a malformed value fails closed rather than being read in part. */
export function parseCloudflareLogins(value: string | undefined): CloudflareLogin[] {
  if (!value) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = undefined; }
  if (!Array.isArray(parsed) || parsed.length > MAX_CLOUDFLARE_LOGINS) throw new ProviderRequestError(502, INVALID);
  const seen = new Set<string>();
  return parsed.map((entry: unknown) => {
    const login = (entry ?? {}) as Record<string, unknown>;
    const accounts = Array.isArray(login.accounts) ? login.accounts.map(account) : [];
    if (typeof login.id !== "string" || !UUID.test(login.id) || seen.has(login.id) ||
        typeof login.accessToken !== "string" || !TOKEN.test(login.accessToken) ||
        typeof login.refreshToken !== "string" || !TOKEN.test(login.refreshToken) ||
        !Number.isSafeInteger(login.expiresAt) || Number(login.expiresAt) <= 0 ||
        !Array.isArray(login.accounts) || login.accounts.length > SNAPSHOT_ACCOUNTS || accounts.some((item) => !item) ||
        typeof login.connectedBy !== "string" || !ACTOR.test(login.connectedBy) ||
        typeof login.connectedAt !== "string" || Number.isNaN(Date.parse(login.connectedAt))) {
      throw new ProviderRequestError(502, INVALID);
    }
    seen.add(login.id);
    return { id: login.id, accessToken: login.accessToken, refreshToken: login.refreshToken,
      expiresAt: Number(login.expiresAt), accounts: accounts as CloudflareAccountRef[],
      connectedBy: login.connectedBy, connectedAt: login.connectedAt };
  });
}

/** The credential value for a list: `null` clears it. Refuses a list that would not fit. */
export function serializeCloudflareLogins(logins: readonly CloudflareLogin[]): string | null {
  if (!logins.length) return null;
  const value = JSON.stringify(logins.map((login) => ({ id: login.id, accessToken: login.accessToken,
    refreshToken: login.refreshToken, expiresAt: login.expiresAt, connectedBy: login.connectedBy,
    connectedAt: login.connectedAt,
    accounts: login.accounts.slice(0, SNAPSHOT_ACCOUNTS).map(({ id, name }) => ({ id, name: name.slice(0, SNAPSHOT_NAME) })) })));
  if (utf8ByteLength(value) > MAX_VALUE_BYTES) {
    throw new ProviderRequestError(409, "the Cloudflare logins no longer fit the connection; remove one first");
  }
  parseCloudflareLogins(value);
  return value;
}

/** What a Space admin sees: accounts and who connected each login, never a token. */
export function cloudflareLoginViews(logins: readonly CloudflareLogin[]): CloudflareLoginView[] {
  return logins.map(({ id, accounts, connectedBy, connectedAt }) => ({ id, accounts, connectedBy, connectedAt }));
}

const sameAccounts = (left: readonly CloudflareAccountRef[], right: readonly CloudflareAccountRef[]) =>
  left.length === right.length && left.every((item) => right.some((other) => other.id === item.id));

/**
 * The stored values with one Connect's grant added as a login. A login that
 * reaches exactly the same accounts is the same Cloudflare user signing in
 * again and is replaced. A grant stored by an earlier single-login connection
 * becomes a login in the same write, so a connection holds one shape. The
 * connection's default account is set only for its first login, so adding a
 * login never reroutes existing subscriptions.
 */
export function addCloudflareLogin(stored: Readonly<Record<string, string>>, grant: {
  accessToken: string; refreshToken: string; expiresAt: number; accounts: CloudflareAccountRef[];
  legacyAccounts?: CloudflareAccountRef[]; actorUserId: string; now?: Date;
}): Record<string, string | null> {
  if (!grant.refreshToken) throw new ProviderRequestError(400, "Cloudflare did not issue a refresh token; restart Connect");
  if (!grant.accounts.length) throw new ProviderRequestError(403, "This Cloudflare login reaches no account");
  const at = (grant.now ?? new Date()).toISOString();
  const current = parseCloudflareLogins(stored.logins);
  const legacy = stored.oauthToken && stored.oauthRefreshToken ? [{ id: crypto.randomUUID(), accessToken: stored.oauthToken,
    refreshToken: stored.oauthRefreshToken, expiresAt: Number(stored.oauthExpiresAt) || 1,
    accounts: (grant.legacyAccounts ?? []).slice(0, SNAPSHOT_ACCOUNTS), connectedBy: "unknown", connectedAt: at }] : [];
  const login: CloudflareLogin = { id: crypto.randomUUID(), accessToken: grant.accessToken, refreshToken: grant.refreshToken,
    expiresAt: grant.expiresAt, accounts: grant.accounts.slice(0, SNAPSHOT_ACCOUNTS), connectedBy: grant.actorUserId, connectedAt: at };
  const kept = [...current, ...legacy].filter((item) => !sameAccounts(item.accounts, login.accounts));
  if (kept.length >= MAX_CLOUDFLARE_LOGINS) {
    throw new ProviderRequestError(409, `a Space connects at most ${MAX_CLOUDFLARE_LOGINS} Cloudflare logins; remove one first`);
  }
  const first = current.length === 0 && legacy.length === 0;
  return {
    logins: serializeCloudflareLogins([...kept, login]),
    oauthToken: null, oauthRefreshToken: null, oauthExpiresAt: null,
    ...(first && !stored.accountId && grant.accounts.length === 1 ? { accountId: grant.accounts[0]!.id } : {}),
  };
}

/** The connection's logins as a Space admin manages them. */
export async function listCloudflareLogins(env: Env, input: { spaceId: string; actorUserId: string }):
  Promise<CloudflareLoginView[]> {
  const stored = await connectorCredentialRepository(env).resolveForAdmin({ requestId: crypto.randomUUID(),
    spaceId: input.spaceId, providerId: "cloudflare", actorUserId: input.actorUserId });
  return cloudflareLoginViews(parseCloudflareLogins(stored?.values.logins));
}

/**
 * Removes exactly one login. Its grant is forgotten here; the Cloudflare user
 * revokes the application itself under My Profile → Access Management.
 */
export async function removeCloudflareLogin(env: Env, input: { spaceId: string; actorUserId: string; id: string }):
  Promise<CloudflareLoginView[]> {
  const repository = connectorCredentialRepository(env);
  const stored = await repository.resolveForAdmin({ requestId: crypto.randomUUID(),
    spaceId: input.spaceId, providerId: "cloudflare", actorUserId: input.actorUserId });
  const logins = parseCloudflareLogins(stored?.values.logins);
  const next = logins.filter((login) => login.id !== input.id);
  if (!stored || next.length === logins.length) throw new ProviderRequestError(404, "That Cloudflare login is not connected");
  await repository.put({ requestId: crypto.randomUUID(), spaceId: input.spaceId, providerId: "cloudflare",
    actorUserId: input.actorUserId, fields: { logins: serializeCloudflareLogins(next) }, expectedGrant: stored,
    policy: { allowed: ["logins"] }, at: new Date().toISOString() });
  return cloudflareLoginViews(next);
}
