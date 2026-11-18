import { importJWK } from "jose";
import type { QueryResultRow } from "pg";
import { SettledCache } from "@xmatrix/protocol";

import { authAuthority, authPostgresTransaction, requireAuthD1 } from "./auth-authority";
import type { Env } from "./types";

const BETTER_AUTH_PUBLIC_KEY_CACHE_TTL_MS = 5 * 60_000;
const BETTER_AUTH_PUBLIC_KEY_CACHE_MAX_ENTRIES = 8;

type BetterAuthJwksRow = {
  id: string;
  publicKey: string;
};

type BetterAuthPublicKey = Awaited<ReturnType<typeof importJWK>>;

const publicKeysByDatabase = new WeakMap<object, SettledCache<string, BetterAuthPublicKey>>();

/**
 * Cache only imported public verification keys. JWT claims and verification
 * results remain request-local, so every token still receives a full signature,
 * issuer, audience, and expiry check. A missing key is not kept, so a newly
 * rotated key is found on the next request; a failed read propagates.
 */
export async function getBetterAuthPublicKey(
  env: Env,
  kid: string,
): Promise<BetterAuthPublicKey | null> {
  const database = authorityCacheKey(env);
  let cache = publicKeysByDatabase.get(database);
  if (!cache) publicKeysByDatabase.set(database, cache = new SettledCache(BETTER_AUTH_PUBLIC_KEY_CACHE_MAX_ENTRIES));
  return cache.read(kid, BETTER_AUTH_PUBLIC_KEY_CACHE_TTL_MS, () => loadBetterAuthPublicKey(env, kid));
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
