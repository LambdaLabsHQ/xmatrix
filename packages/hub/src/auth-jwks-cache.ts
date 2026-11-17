import { importJWK } from "jose";
import type { QueryResultRow } from "pg";

import { authAuthority, authPostgresTransaction, requireAuthD1 } from "./auth-authority";
import type { Env } from "./types";

const BETTER_AUTH_PUBLIC_KEY_CACHE_TTL_MS = 5 * 60_000;
const BETTER_AUTH_PUBLIC_KEY_CACHE_MAX_ENTRIES = 8;

type BetterAuthJwksRow = {
  id: string;
  publicKey: string;
};

type BetterAuthPublicKey = Awaited<ReturnType<typeof importJWK>>;

type BetterAuthPublicKeyCacheEntry = {
  expiresAt: number;
  publicKey: BetterAuthPublicKey;
};

const publicKeysByDatabase = new WeakMap<
  object,
  Map<string, BetterAuthPublicKeyCacheEntry>
>();

/**
 * Cache only imported public verification keys. JWT claims and verification
 * results remain request-local, so every token still receives a full signature,
 * issuer, audience, and expiry check.
 *
 * Only a settled key is cached. A Worker request cannot await a promise another
 * request created: once that request ends, its unsettled read is dropped and
 * every waiter fails ("can never settle", HUB-DJ). Concurrent first reads of
 * one key each read it; the first to settle fills the cache.
 */
export async function getBetterAuthPublicKey(
  env: Env,
  kid: string,
): Promise<BetterAuthPublicKey | null> {
  const cache = cacheForDatabase(authorityCacheKey(env));
  const cached = cache.get(kid);
  if (cached && cached.expiresAt > Date.now()) {
    // Refresh insertion order so the bounded map behaves as an LRU cache.
    cache.delete(kid);
    cache.set(kid, cached);
    return cached.publicKey;
  }
  if (cached) cache.delete(kid);

  // A missing key is not cached, so a newly rotated key is found on the next
  // request; a failed read propagates and is not cached either.
  const publicKey = await loadBetterAuthPublicKey(env, kid);
  if (!publicKey) return null;
  cache.set(kid, {
    expiresAt: Date.now() + BETTER_AUTH_PUBLIC_KEY_CACHE_TTL_MS,
    publicKey,
  });
  pruneOldestPublicKeys(cache);
  return publicKey;
}

function cacheForDatabase(
  database: object,
): Map<string, BetterAuthPublicKeyCacheEntry> {
  const existing = publicKeysByDatabase.get(database);
  if (existing) return existing;
  const cache = new Map<string, BetterAuthPublicKeyCacheEntry>();
  publicKeysByDatabase.set(database, cache);
  return cache;
}

async function loadBetterAuthPublicKey(
  env: Env,
  kid: string,
): Promise<BetterAuthPublicKey | null> {
  // A failed read propagates: an outage is not an unknown key, and answering
  // it as one would sign every client out while the database is down.
  let row: BetterAuthJwksRow | null;
  if (authAuthority(env) === "d1") {
    row = await requireAuthD1(env)
      .prepare('SELECT "id", "publicKey" FROM "jwks" WHERE "id" = ?')
      .bind(kid)
      .first<BetterAuthJwksRow>();
  } else {
    row = await authPostgresTransaction(env, "auth.jwks.read", async (transaction) => {
      const rows = await transaction.query<QueryResultRow & BetterAuthJwksRow>({
        name: "auth_jwks_read_v1",
        text: `SELECT id, public_key AS "publicKey" FROM control.auth_jwks WHERE id = $1 LIMIT 1`,
        values: [kid], maxRows: 1,
      });
      return rows[0] ?? null;
    }, { statement: "single_read" });
  }
  if (!row) return null;
  return importJWK(JSON.parse(row.publicKey) as JsonWebKey, "ES256");
}

function authorityCacheKey(env: Env): object {
  return authAuthority(env) === "postgres"
    ? env.RELAY_POSTGRES ?? env
    : env.AUTH_DB ?? env;
}

function pruneOldestPublicKeys(
  cache: Map<string, BetterAuthPublicKeyCacheEntry>,
): void {
  while (cache.size > BETTER_AUTH_PUBLIC_KEY_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}
