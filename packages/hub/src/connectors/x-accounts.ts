import { appCredentialValueLimit, ControlError } from "@xmatrix/db";
import { utf8ByteLength } from "@xmatrix/protocol";
import type { Env } from "../types";
import { retryablePostgresFailure } from "../postgres-error-classification";
import { connectorCredentialRepository } from "./credentials";
import { ProviderRequestError } from "./http";

/** Each account is a separate grant, inside the connection's existing encrypted envelope. */
export interface XAccountView { id: string; username: string; generation: string }
export interface XAccount extends XAccountView {
  ownerUserId: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string;
  refreshing?: string;
  refreshStartedAt?: number;
  needsReconnect?: boolean;
}
export interface XActionCapability {
  accounts(): Promise<XAccountView[]>;
  request(account: XAccountView, method: "GET" | "POST", path: string,
    body?: Record<string, unknown>): Promise<Record<string, unknown>>;
  reserveMedia?(maximumRequests: number): Promise<() => Promise<void>>;
  billingSummary?(): string;
}

const ID = /^[1-9][0-9]{0,19}$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
/* Accounts are not counted. The list is bounded only by the size the platform stores for it. */
const MAX_VALUE_BYTES = appCredentialValueLimit("x", "accounts");

export function parseXAccounts(value: string | undefined): XAccount[] {
  if (!value) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = undefined; }
  if (!Array.isArray(parsed) || utf8ByteLength(value) > MAX_VALUE_BYTES) {
    throw new ProviderRequestError(409, "The X account list is invalid; reconnect X");
  }
  const seen = new Set<string>();
  return parsed.map((item: unknown) => {
    const a = item as Partial<XAccount> | null;
    const token = (v: unknown) => typeof v === "string" && /^[\x21-\x7e]{1,2048}$/u.test(v);
    if (!a || typeof a !== "object" || typeof a.id !== "string" || !ID.test(a.id) || seen.has(a.id) ||
        typeof a.username !== "string" || !/^[A-Za-z0-9_]{1,15}$/u.test(a.username) ||
        typeof a.generation !== "string" || !UUID.test(a.generation) ||
        typeof a.ownerUserId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(a.ownerUserId) ||
        !token(a.clientId) || !token(a.accessToken) || !token(a.refreshToken) ||
        !Number.isSafeInteger(a.expiresAt) || a.expiresAt! <= 0 || typeof a.scopes !== "string" || a.scopes.length > 500 ||
        (a.needsReconnect !== undefined && typeof a.needsReconnect !== "boolean") ||
        (a.refreshing !== undefined && (!UUID.test(a.refreshing) || !Number.isSafeInteger(a.refreshStartedAt)))) {
      throw new ProviderRequestError(409, "The X account list is invalid; reconnect X");
    }
    seen.add(a.id);
    return a as XAccount;
  });
}

export function xAccountFields(accounts: readonly XAccount[]): { accounts: string | null } {
  if (!accounts.length) return { accounts: null };
  const value = JSON.stringify(accounts);
  if (utf8ByteLength(value) > MAX_VALUE_BYTES) {
    throw new ProviderRequestError(409, `the X accounts exceed the ${MAX_VALUE_BYTES / 1024} KiB this connection stores; remove one first`);
  }
  parseXAccounts(value);
  return { accounts: value };
}

/** Retry local grant persistence only; provider token rotation must stay outside this boundary. */
export async function retryXCredentialWrite<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retry = !(error instanceof ProviderRequestError) && (error instanceof ControlError
        ? error.code === "credential_changed" : retryablePostgresFailure(error));
      if (!retry || attempt === 7) throw error;
      const delay = Math.min(50 * 2 ** attempt, 500) + Math.floor(Math.random() * 50);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/** A callback may add an account; it cannot take another member's account over. */
export async function connectXAccount(env: Env, input: { spaceId: string; actorUserId: string; fields: Record<string, string | null>;
  snapshot: { connectionVersion: number; credentialVersion: number; connectionGeneration: string } }): Promise<void> {
  const repository = connectorCredentialRepository(env);
  const grant = parseXAccounts(input.fields.accounts ?? undefined);
  if (grant.length !== 1 || grant[0]!.ownerUserId !== input.actorUserId) throw new ProviderRequestError(400, "Restart X Connect");
  const account = grant[0]!;
  await retryXCredentialWrite(async () => {
    const stored = await repository.resolveForAdmin({ requestId: crypto.randomUUID(), spaceId: input.spaceId,
      providerId: "x", actorUserId: input.actorUserId });
    const latest = stored ? { connectionVersion: stored.connectionVersion, credentialVersion: stored.version,
      connectionGeneration: stored.connectionGeneration } : await repository.installationSnapshot({ requestId: crypto.randomUUID(),
      spaceId: input.spaceId, providerId: "x", actorUserId: input.actorUserId });
    if (latest.connectionGeneration !== input.snapshot.connectionGeneration) {
      throw new ProviderRequestError(409, "The X connection changed during authorization; restart Connect");
    }
    const current = parseXAccounts(stored?.values.accounts);
    // A callback COMMIT can succeed before its acknowledgement is lost. Its
    // exact newly minted grant confirms that success without another write.
    if (current.some(a => a.id === account.id && a.generation === account.generation &&
        a.ownerUserId === account.ownerUserId && a.clientId === account.clientId && a.username === account.username &&
        a.accessToken === account.accessToken && a.refreshToken === account.refreshToken &&
        a.scopes === account.scopes && a.expiresAt === account.expiresAt)) return;
    // Hub refreshes change only the encrypted envelope. Human edits still
    // invalidate the signed Connect start when this grant has not committed.
    if (latest.connectionVersion !== input.snapshot.connectionVersion) {
      throw new ProviderRequestError(409, "The X connection changed during authorization; restart Connect");
    }
    if (current.some(a => a.id === account.id && a.ownerUserId !== input.actorUserId)) {
      throw new ProviderRequestError(403, "This X account belongs to another Space member");
    }
    const kept = current.filter(a => a.id !== account.id);
    await repository.put({ requestId: crypto.randomUUID(), spaceId: input.spaceId, providerId: "x", actorUserId: input.actorUserId,
      fields: xAccountFields([...kept, account]), policy: { allowed: ["accounts"] }, at: new Date().toISOString(),
      expectedGrant: { connectionVersion: input.snapshot.connectionVersion, version: latest.credentialVersion,
        connectionGeneration: input.snapshot.connectionGeneration } });
  });
}

export async function listXAccounts(env: Env, input: { spaceId: string; actorUserId: string }) {
  const stored = await connectorCredentialRepository(env).resolveForAdmin({ requestId: crypto.randomUUID(),
    ...input, providerId: "x" });
  return parseXAccounts(stored?.values.accounts).map(a => ({ id: a.id, username: a.username, generation: a.generation,
    ownerUserId: a.ownerUserId, expiresAt: new Date(a.expiresAt).toISOString(),
    needsReconnect: a.needsReconnect === true || !!a.refreshing && Date.now() - (a.refreshStartedAt ?? 0) > 30_000 }));
}

/** Forget exactly the inspected account generation; a late click cannot remove a new grant. */
export async function removeXAccount(env: Env, input: { spaceId: string; actorUserId: string; id: string; generation: string }) {
  const repository = connectorCredentialRepository(env);
  const stored = await repository.resolveForAdmin({ requestId: crypto.randomUUID(), ...input, providerId: "x" });
  const accounts = parseXAccounts(stored?.values.accounts);
  const account = accounts.find(a => a.id === input.id && a.generation === input.generation);
  if (!stored || !account) throw new ProviderRequestError(409, "The X account changed; reload its account list");
  await repository.put({ requestId: crypto.randomUUID(), spaceId: input.spaceId, providerId: "x", actorUserId: input.actorUserId,
    fields: xAccountFields(accounts.filter(a => a !== account)), expectedGrant: stored,
    policy: { allowed: ["accounts"] }, at: new Date().toISOString() });
  return listXAccounts(env, input);
}
