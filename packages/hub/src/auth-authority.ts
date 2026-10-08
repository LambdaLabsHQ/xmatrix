import {
  ADMIN_OVERVIEW_MAX_USER_ROWS,
  ADMIN_USER_DETAIL_MAX_ROWS,
  type AdminUserAccessSummary,
  type AdminUserSession,
  type AdminUserSummary,
} from "@xmatrix/protocol";
import {
  createAuthorityDatabase,
  type DatabaseTransaction,
} from "@xmatrix/db";
import { Pool, types as pgTypes } from "pg";
import type { CustomTypesConfig, QueryResultRow } from "pg";

import type { Env } from "./types";
import { postgresDatabaseObservers } from "./postgres-observability";

export type AuthAuthority = "d1" | "postgres";

const POSTGRES_INT8_OID = 20;

export function parseAuthPostgresInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("PostgreSQL Auth integer exceeds the JavaScript safe range");
  }
  return parsed;
}

/** Better Auth declares profileVersion as a number, while pg returns int8 as text by default. */
export const AUTH_POSTGRES_TYPES: CustomTypesConfig = {
  getTypeParser(oid, format) {
    if (oid === POSTGRES_INT8_OID && (format === undefined || format === "text")) {
      return parseAuthPostgresInt8;
    }
    return pgTypes.getTypeParser(oid, format);
  },
};

export function authAuthority(env: Pick<Env, "AUTH_AUTHORITY">): AuthAuthority {
  const configured = env.AUTH_AUTHORITY?.trim() || "d1";
  if (configured !== "d1" && configured !== "postgres") {
    throw new Error("AUTH_AUTHORITY must be d1 or postgres");
  }
  return configured;
}

function postgresSettings(env: Env): { connectionString: string; shardId: string } {
  const connectionString = env.RELAY_POSTGRES?.connectionString;
  const shardId = env.RELAY_POSTGRES_SHARD_ID?.trim();
  if (!connectionString || !shardId) {
    throw new Error("PostgreSQL Auth authority bindings are unavailable");
  }
  return { connectionString, shardId };
}

export function requireAuthD1(env: Env): D1Database {
  if (authAuthority(env) !== "d1" || !env.AUTH_DB) {
    throw new Error("D1 Auth authority is unavailable");
  }
  return env.AUTH_DB;
}

export async function authPostgresTransaction<T>(
  env: Env,
  operation: string,
  callback: (transaction: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  if (authAuthority(env) !== "postgres") {
    throw new Error("PostgreSQL is not the Auth authority");
  }
  const settings = postgresSettings(env);
  const database = createAuthorityDatabase({ ...postgresDatabaseObservers(env),
    ...settings,
    applicationName: "xmatrix-hub-auth",
    statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000,
    lockTimeoutMs: 2_000,
  });
  return database.transaction({
    requestId: `auth:${crypto.randomUUID()}`,
    operation,
  }, callback);
}

/**
 * Create the Better Auth adapter pool for one Worker request.
 *
 * Hyperdrive owns cross-request connection pooling. A Worker must not retain a
 * node-postgres Pool because its sockets belong to the request I/O context in
 * which they were created.
 *
 * Hyperdrive resets session state between transactions and drops libpq startup
 * options, so this pool does not SET search_path. Better Auth addresses
 * `control.auth_*` directly (`AUTH_POSTGRES_MODELS`); the queries below do too.
 */
export function createAuthPostgresPool(env: Env): Pool {
  if (authAuthority(env) !== "postgres") {
    throw new Error("PostgreSQL is not the Auth authority");
  }
  const settings = postgresSettings(env);
  return new Pool({
    connectionString: settings.connectionString,
    types: AUTH_POSTGRES_TYPES,
    application_name: "xmatrix-hub-auth-adapter",
    max: 5,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 5_000,
  });
}

export async function withAuthPostgresPool<T>(
  env: Env,
  callback: (pool: Pool) => Promise<T>,
  poolFactory: (env: Env) => Pool = createAuthPostgresPool,
): Promise<T> {
  const pool = poolFactory(env);
  try {
    return await callback(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function authDirectoryEmails(
  env: Env,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  if (userIds.length === 0) return emails;
  if (authAuthority(env) === "d1") {
    const placeholders = userIds.map(() => "?").join(", ");
    const result = await requireAuthD1(env)
      .prepare(`SELECT "id", "email" FROM "user" WHERE "id" IN (${placeholders})`)
      .bind(...userIds)
      .all<{ id: string; email: string }>();
    for (const row of result.results ?? []) {
      if (row.id && row.email) emails.set(row.id, row.email);
    }
    return emails;
  }
  return authPostgresTransaction(env, "auth.directory.emails", async (transaction) => {
    const rows = await transaction.query<QueryResultRow & { id: string; email: string }>({
      name: "auth_directory_emails_v1",
      text: "SELECT id, email FROM control.auth_users WHERE id = ANY($1::text[]) LIMIT 200",
      values: [[...userIds]], maxRows: 200,
    });
    for (const row of rows) {
      if (row.id && row.email) emails.set(row.id, row.email);
    }
    return emails;
  });
}

/** The user who linked this GitHub account (by GitHub's numeric user id), if anyone did. */
export async function authUserByGitHubId(env: Env, githubUserId: string): Promise<string | null> {
  if (authAuthority(env) === "d1") {
    const row = await requireAuthD1(env)
      .prepare(`SELECT "userId" FROM "account" WHERE "providerId" = 'github' AND "accountId" = ? LIMIT 1`)
      .bind(githubUserId)
      .first<{ userId: string }>();
    return row?.userId ?? null;
  }
  return authPostgresTransaction(env, "auth.directory.github", async (transaction) => {
    const rows = await transaction.query<QueryResultRow & { user_id: string }>({
      name: "auth_directory_github_user_v1",
      text: "SELECT user_id FROM control.auth_accounts WHERE provider_id = 'github' AND account_id = $1 LIMIT 1",
      values: [githubUserId], maxRows: 1,
    });
    return rows[0]?.user_id ?? null;
  });
}

/** Whether this person has linked a GitHub account, the identity an open project requires. */
export async function authHasGitHubAccount(env: Env, userId: string): Promise<boolean> {
  if (authAuthority(env) === "d1") {
    const row = await requireAuthD1(env)
      .prepare(`SELECT 1 AS linked FROM "account" WHERE "providerId" = 'github' AND "userId" = ? LIMIT 1`)
      .bind(userId)
      .first<{ linked: number }>();
    return Boolean(row);
  }
  return authPostgresTransaction(env, "auth.directory.github.linked", async (transaction) => (await transaction.query({
    name: "auth_directory_github_linked_v1",
    text: "SELECT 1 FROM control.auth_accounts WHERE provider_id = 'github' AND user_id = $1 LIMIT 1",
    values: [userId], maxRows: 1,
  })).length > 0);
}

interface AdminAuthUserRow {
  id: string;
  name: string | null;
  handle: string | null;
  email: string;
  email_verified: boolean | number;
  created_at: Date | string | number;
  profile_completed_at: Date | string | number | null;
  session_count: string | number;
  active_sessions: string | number;
  last_session_at: Date | string | number | null;
  providers: string[] | string | null;
  total_count?: string | number;
}

export interface AuthDirectoryAdminUsers {
  users: AdminUserSummary[];
  access: AdminUserAccessSummary;
}

/**
 * Complete bounded registration inventory for the operator overview.
 *
 * Session timestamps are the closest existing access signal. IP addresses,
 * user agents, tokens, and account credentials deliberately stay in Auth.
 */
export async function authDirectoryAdminUsers(
  env: Env,
  now: string,
  limit: number,
): Promise<AuthDirectoryAdminUsers> {
  const nowDate = new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error("admin user access time is invalid");
  const rows = authAuthority(env) === "d1"
    ? await readD1AdminUsers(env, now)
    : await readPostgresAdminUsers(env, now);
  if (rows.length > ADMIN_OVERVIEW_MAX_USER_ROWS) {
    throw new Error("Auth admin user inventory bound was reached");
  }
  const users = rows.map(adminAuthUser).sort((left, right) =>
    (right.registeredAt ?? "").localeCompare(left.registeredAt ?? "")
      || left.userId.localeCompare(right.userId));
  return {
    users: users.slice(0, limit),
    access: summarizeAdminUserAccess(users, nowDate.getTime()),
  };
}

const D1_ADMIN_USER_SELECT = `SELECT u."id", u."name", u."handle", u."email",
      u."emailVerified" AS "email_verified", u."createdAt" AS "created_at",
      u."profileCompletedAt" AS "profile_completed_at",
      (SELECT COUNT(*) FROM "session" s WHERE s."userId" = u."id") AS "session_count",
      (SELECT COUNT(*) FROM "session" s
        WHERE s."userId" = u."id" AND s."expiresAt" > ?1) AS "active_sessions",
      (SELECT MAX(s."updatedAt") FROM "session" s
        WHERE s."userId" = u."id") AS "last_session_at",
      (SELECT GROUP_CONCAT(provider."providerId")
        FROM (SELECT DISTINCT a."providerId" FROM "account" a
          WHERE a."userId" = u."id" ORDER BY a."providerId") provider) AS "providers"
     FROM "user" u`;

async function readD1AdminUsers(
  env: Env,
  now: string,
  userId?: string,
): Promise<AdminAuthUserRow[]> {
  const database = requireAuthD1(env);
  if (userId) {
    const result = await database.prepare(`${D1_ADMIN_USER_SELECT} WHERE u."id" = ?2 LIMIT 1`)
      .bind(now, userId).all<AdminAuthUserRow>();
    return result.results ?? [];
  }
  const total = await database.prepare('SELECT COUNT(*) AS "count" FROM "user"')
    .first<{ count: number }>();
  if (Number(total?.count ?? 0) > ADMIN_OVERVIEW_MAX_USER_ROWS) {
    throw new Error("Auth admin user inventory bound was reached");
  }
  const result = await database.prepare(
    `${D1_ADMIN_USER_SELECT} ORDER BY u."createdAt" DESC, u."id" LIMIT ?2`,
  ).bind(now, ADMIN_OVERVIEW_MAX_USER_ROWS).all<AdminAuthUserRow>();
  const rows = result.results ?? [];
  if (rows.length < Number(total?.count ?? 0)) {
    throw new Error("Auth admin user inventory changed during the read");
  }
  return rows;
}

const POSTGRES_ADMIN_USER_SELECT = `SELECT u.id, u.name, u.handle, u.email, u.email_verified,
        u.created_at, u.profile_completed_at,
        (SELECT COUNT(*) FROM control.auth_sessions s WHERE s.user_id = u.id) AS session_count,
        (SELECT COUNT(*) FROM control.auth_sessions s
          WHERE s.user_id = u.id AND s.expires_at > $1::timestamptz) AS active_sessions,
        (SELECT MAX(s.updated_at) FROM control.auth_sessions s
          WHERE s.user_id = u.id) AS last_session_at,
        ARRAY(SELECT DISTINCT a.provider_id FROM control.auth_accounts a
          WHERE a.user_id = u.id ORDER BY a.provider_id) AS providers`;

async function readPostgresAdminUsers(
  env: Env,
  now: string,
): Promise<AdminAuthUserRow[]> {
  return authPostgresTransaction(env, "auth.admin.users", async (transaction) => {
    const rows = await transaction.query<QueryResultRow & AdminAuthUserRow>({
      name: "auth_admin_users_v1",
      text: `${POSTGRES_ADMIN_USER_SELECT}, COUNT(*) OVER () AS total_count
       FROM control.auth_users u ORDER BY u.created_at DESC, u.id
       LIMIT ${ADMIN_OVERVIEW_MAX_USER_ROWS}`,
      values: [now],
      maxRows: ADMIN_OVERVIEW_MAX_USER_ROWS,
    });
    if (Number(rows[0]?.total_count ?? 0) > ADMIN_OVERVIEW_MAX_USER_ROWS) {
      throw new Error("Auth admin user inventory bound was reached");
    }
    return [...rows];
  });
}

interface AdminAuthSessionRow {
  created_at: Date | string | number;
  updated_at: Date | string | number;
  expires_at: Date | string | number;
}

export interface AuthDirectoryAdminUser {
  user: AdminUserSummary;
  sessions: AdminUserSession[];
}

/**
 * One registered user for the operator detail: identity, sign-in methods, and
 * session timing. IP addresses, user agents, and tokens stay in Auth.
 */
export async function authDirectoryAdminUser(
  env: Env,
  userId: string,
  now: string,
): Promise<AuthDirectoryAdminUser | null> {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("admin user access time is invalid");
  const bound = ADMIN_USER_DETAIL_MAX_ROWS;
  let userRows: AdminAuthUserRow[];
  let sessionRows: AdminAuthSessionRow[];
  if (authAuthority(env) === "d1") {
    userRows = await readD1AdminUsers(env, now, userId);
    sessionRows = (await requireAuthD1(env).prepare(
      `SELECT "createdAt" AS "created_at", "updatedAt" AS "updated_at", "expiresAt" AS "expires_at"
       FROM "session" WHERE "userId" = ?1 ORDER BY "updatedAt" DESC LIMIT ?2`,
    ).bind(userId, bound).all<AdminAuthSessionRow>()).results ?? [];
  } else {
    [userRows, sessionRows] = await authPostgresTransaction(env, "auth.admin.user", async (transaction) => [
      [...await transaction.query<QueryResultRow & AdminAuthUserRow>({
        name: "auth_admin_user_v1",
        text: `${POSTGRES_ADMIN_USER_SELECT} FROM control.auth_users u WHERE u.id = $2 LIMIT 1`,
        values: [now, userId],
        maxRows: 1,
      })],
      [...await transaction.query<QueryResultRow & AdminAuthSessionRow>({
        name: "auth_admin_user_sessions_v1",
        text: `SELECT created_at, updated_at, expires_at FROM control.auth_sessions
          WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
        values: [userId, bound],
        maxRows: bound,
      })],
    ] as const);
  }
  const row = userRows[0];
  if (!row) return null;
  return {
    user: adminAuthUser(row),
    sessions: sessionRows.flatMap((session) => {
      const createdAt = adminAuthTimestamp(session.created_at);
      const lastActiveAt = adminAuthTimestamp(session.updated_at);
      const expiresAt = adminAuthTimestamp(session.expires_at);
      if (!createdAt || !lastActiveAt || !expiresAt) return [];
      return [{ createdAt, lastActiveAt, expiresAt, active: Date.parse(expiresAt) > nowMs }];
    }),
  };
}

function adminAuthUser(row: AdminAuthUserRow): AdminUserSummary {
  const registeredAt = adminAuthTimestamp(row.created_at);
  if (!registeredAt) throw new Error("Auth admin user has an invalid registration time");
  const lastSessionAt = adminAuthTimestamp(row.last_session_at);
  return {
    userId: row.id,
    ...(row.name ? { name: row.name } : {}),
    ...(row.handle ? { handle: row.handle } : {}),
    email: row.email,
    spaces: 0,
    ownedSpaces: 0,
    agentRegistrations: 0,
    machines: 0,
    messages: 0,
    registeredAt,
    ...(lastSessionAt ? { lastSessionAt } : {}),
    sessionCount: adminAuthCount(row.session_count),
    activeSessions: adminAuthCount(row.active_sessions),
    emailVerified: row.email_verified === true || row.email_verified === 1,
    profileCompleted: row.profile_completed_at != null,
    providers: Array.isArray(row.providers)
      ? row.providers.filter(Boolean)
      : typeof row.providers === "string" && row.providers
        ? row.providers.split(",").filter(Boolean)
        : [],
  };
}

function adminAuthCount(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Auth admin user has an invalid count");
  }
  return parsed;
}

function summarizeAdminUserAccess(
  users: AdminUserSummary[],
  nowMs: number,
): AdminUserAccessSummary {
  const activeSince = (user: AdminUserSummary, days: number): boolean => {
    const last = user.lastSessionAt ? Date.parse(user.lastSessionAt) : Number.NaN;
    return Number.isFinite(last) && last >= nowMs - days * 24 * 60 * 60 * 1_000;
  };
  return {
    registeredUsers: users.length,
    emailVerifiedUsers: users.filter((user) => user.emailVerified).length,
    completedProfiles: users.filter((user) => user.profileCompleted).length,
    activeUsersLast24h: users.filter((user) => activeSince(user, 1)).length,
    activeUsersLast7d: users.filter((user) => activeSince(user, 7)).length,
    activeUsersLast30d: users.filter((user) => activeSince(user, 30)).length,
  };
}

function adminAuthTimestamp(value: Date | string | number | null): string | undefined {
  if (value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
