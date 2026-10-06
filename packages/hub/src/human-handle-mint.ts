/**
 * Minting the `@` address for an account that has none.
 *
 * `handle` shipped nullable because no account had one yet, and the migration
 * that added it said the backfill would fill it. The backfill was never
 * written, so every account created since carries `handle IS NULL` — and `@`
 * went on resolving display names, which are unique nowhere. This module is
 * that missing half: one function that turns an account into a handle, called
 * from the account-creation hook so it never falls behind again, and from an
 * operator-triggered backfill for the accounts that predate it.
 *
 * The candidate list is a pure function of the row (see
 * `humanHandleMintCandidates`), so this is safe to interrupt and re-run: a
 * second pass computes the same first choice, finds the account already
 * holding it, and leaves it alone.
 *
 * Nothing here ever takes a handle away or hands one person's handle to
 * another. A retired handle disqualifies a candidate outright, because the
 * whole reason `retired_human_handle` exists is that old mentions are plain
 * text and re-pointing them at a new human is worse than letting them go dead.
 */

import {
  humanHandleMintCandidates,
  humanHandleShortCode,
  isUnusableHumanIdentitySource,
  neutralHumanIdentity,
  type HumanProfile,
} from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";

import { authAuthority, authPostgresTransaction } from "./auth-authority";
import { syncHumanProfile } from "./human-profile-sync";
import type { Env } from "./types";

/** Columns minting reads, named once so the two queries cannot drift. */
const ACCOUNT_COLUMNS =
  '"id", "name", "image", "bio", "timeZone", "profileVersion", "profileCompletedAt"';

/** The account fields minting reads. */
export interface MintableAccount {
  id: string;
  name: string | null;
  image: string | null;
  bio: string | null;
  timeZone: string | null;
  profileVersion: number;
  profileCompletedAt: string | null;
}

export interface HumanHandleMintOutcome {
  userId: string;
  handle?: string;
  /** Why no handle was written; absent on success. */
  skipped?: "no_candidate" | "all_taken" | "write_conflict";
}

/**
 * The first candidate nobody holds, or `undefined` when the account cannot
 * produce one at all.
 *
 * "Held" spans live handles and retired ones together. Checking both in one
 * statement keeps the decision a single point in time: two candidates judged
 * by two queries could both look free to concurrent callers.
 */
export async function availableHandleForAccount(
  db: D1Database,
  account: Pick<MintableAccount, "id" | "name">,
): Promise<string | undefined> {
  const candidates = humanHandleMintCandidates(account.name, account.id);
  if (candidates.length === 0) return undefined;

  const placeholders = candidates.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT "handle" AS handle FROM "user" WHERE "handle" COLLATE NOCASE IN (${placeholders})
     UNION ALL
     SELECT "handle" AS handle FROM "retired_human_handle" WHERE "handle" COLLATE NOCASE IN (${placeholders})`,
  ).bind(...candidates, ...candidates).all<{ handle: string }>();

  const taken = new Set(
    (rows.results || []).map((row) => (row.handle || "").trim().toLowerCase()),
  );
  return candidates.find((candidate) => !taken.has(candidate));
}

/**
 * Give one account a handle, if it has none.
 *
 * The update is guarded on both `handle IS NULL` and the profile version it
 * read, so a person who set their own handle in the meantime keeps it: this
 * writes only when it is still filling a hole. A lost race reports
 * `write_conflict` rather than retrying, because the winner is by definition
 * a better answer than anything this function would mint.
 *
 * Returns the profile to publish, so the caller owns whether and when Relay
 * Authority is told — the account write must not depend on that hop succeeding.
 */
export async function mintHandleForAccount(
  db: D1Database,
  account: MintableAccount,
  now: string,
): Promise<{ outcome: HumanHandleMintOutcome; profile?: HumanProfile }> {
  const handle = await availableHandleForAccount(db, account);
  if (!handle) {
    const candidates = humanHandleMintCandidates(account.name, account.id);
    return {
      outcome: {
        userId: account.id,
        skipped: candidates.length === 0 ? "no_candidate" : "all_taken",
      },
    };
  }

  const { nextVersion, generatedDisplayName } = mintedProfileFields(account);
  let changes = 0;
  try {
    const result = await db.prepare(
      `UPDATE "user" SET "handle" = ?, "name" = COALESCE(?, "name"), "profileVersion" = ?, "updatedAt" = ?
        WHERE "id" = ? AND "handle" IS NULL AND "profileVersion" = ?`,
    ).bind(handle, generatedDisplayName ?? null, nextVersion, now, account.id, account.profileVersion).run();
    changes = result.meta.changes ?? 0;
  } catch (error) {
    // A concurrent mint can take this handle between the read and the write.
    // The unique index is what makes that safe, and losing is not an error.
    if (/unique|constraint/iu.test((error as Error).message)) {
      return { outcome: { userId: account.id, skipped: "write_conflict" } };
    }
    throw error;
  }
  if (changes !== 1) return { outcome: { userId: account.id, skipped: "write_conflict" } };

  return mintedHandleResult(account, handle, nextVersion, generatedDisplayName);
}

function mintedProfileFields(account: MintableAccount): {
  nextVersion: number;
  generatedDisplayName?: string;
} {
  const shortCode = humanHandleShortCode(account.id);
  const generatedDisplayName = isUnusableHumanIdentitySource(account.name) && shortCode
    ? neutralHumanIdentity(shortCode).displayName
    : undefined;
  return { nextVersion: account.profileVersion + 1, ...(generatedDisplayName ? { generatedDisplayName } : {}) };
}

function mintedHandleResult(
  account: MintableAccount,
  handle: string,
  nextVersion: number,
  generatedDisplayName?: string,
): { outcome: HumanHandleMintOutcome; profile: HumanProfile } {
  const displayName = generatedDisplayName || account.name?.trim();
  return {
    outcome: { userId: account.id, handle },
    profile: {
      identityId: `user:${account.id}`,
      userId: account.id,
      // Better Auth may use the email address as `name` when email OTP creates
      // an account. That is not a person-chosen name and must not leak into
      // messages, so it gets the matching neutral display name. Real names,
      // including names that cannot produce an ASCII handle, stay untouched.
      displayName: displayName || handle,
      handle,
      ...(account.image ? { avatarUrl: account.image } : {}),
      ...(account.bio ? { bio: account.bio } : {}),
      ...(account.timeZone ? { timeZone: account.timeZone } : {}),
      // The handle is one the system chose, not one the person confirmed.
      // `profileCompletedAt` is where that fact is stored, so it is also where
      // it is read from rather than being asserted a second time here.
      ...(account.profileCompletedAt ? {} : { handleIsTemporary: true }),
      profileVersion: nextVersion,
    },
  };
}

/** One page of accounts still waiting for an address, oldest first. */
export async function accountsWithoutHandle(
  db: D1Database,
  limit: number,
): Promise<MintableAccount[]> {
  const rows = await db.prepare(
    `SELECT ${ACCOUNT_COLUMNS} FROM "user" WHERE "handle" IS NULL ORDER BY "createdAt" ASC LIMIT ?`,
  ).bind(limit).all<MintableAccount>();
  return rows.results || [];
}

type PgMintableRow = QueryResultRow & Omit<MintableAccount, "profileCompletedAt"> & {
  profileCompletedAt: Date | string | null;
};

function pgMintableAccount(row: PgMintableRow): MintableAccount {
  return {
    ...row,
    profileVersion: Number(row.profileVersion),
    profileCompletedAt: row.profileCompletedAt instanceof Date
      ? row.profileCompletedAt.toISOString()
      : row.profileCompletedAt,
  };
}

async function postgresAccount(env: Env, userId: string): Promise<MintableAccount | null> {
  return authPostgresTransaction(env, "auth.handle.read_account", async (transaction) => {
    const rows = await transaction.query<PgMintableRow>({
      name: "auth_handle_read_account_v1",
      text: `SELECT id, name, image, bio, time_zone AS "timeZone",
        profile_version::int AS "profileVersion",
        profile_completed_at AS "profileCompletedAt"
        FROM control.auth_users WHERE id = $1 LIMIT 1`,
      values: [userId], maxRows: 1,
    });
    return rows[0] ? pgMintableAccount(rows[0]) : null;
  });
}

async function postgresAccountsWithoutHandle(env: Env, limit: number): Promise<MintableAccount[]> {
  return authPostgresTransaction(env, "auth.handle.list_missing", async (transaction) => {
    const rows = await transaction.query<PgMintableRow>({
      name: "auth_handle_list_missing_v1",
      text: `SELECT id, name, image, bio, time_zone AS "timeZone",
        profile_version::int AS "profileVersion",
        profile_completed_at AS "profileCompletedAt"
        FROM control.auth_users WHERE handle IS NULL ORDER BY created_at ASC LIMIT $1`,
      values: [limit], maxRows: limit,
    });
    return rows.map(pgMintableAccount);
  });
}

async function postgresMintHandleForAccount(
  env: Env,
  account: MintableAccount,
  now: string,
): Promise<{ outcome: HumanHandleMintOutcome; profile?: HumanProfile }> {
  const candidates = humanHandleMintCandidates(account.name, account.id);
  if (candidates.length === 0) {
    return { outcome: { userId: account.id, skipped: "no_candidate" } };
  }
  try {
    return await authPostgresTransaction(env, "auth.handle.mint", async (transaction) => {
      const rows = await transaction.query<QueryResultRow & { handle: string }>({
        name: "auth_handle_taken_v1",
        text: `SELECT handle FROM control.auth_users WHERE lower(handle) = ANY($1::text[])
          UNION ALL SELECT handle FROM control.retired_human_handles
          WHERE lower(handle) = ANY($1::text[])`,
        values: [candidates], maxRows: candidates.length * 2,
      });
      const taken = new Set(rows.map((row) => row.handle.trim().toLowerCase()));
      const handle = candidates.find((candidate) => !taken.has(candidate));
      if (!handle) return { outcome: { userId: account.id, skipped: "all_taken" as const } };

      const { nextVersion, generatedDisplayName } = mintedProfileFields(account);
      const updated = await transaction.query<QueryResultRow>({
        name: "auth_handle_mint_v1",
        text: `UPDATE control.auth_users SET handle = $1, name = COALESCE($2, name),
          profile_version = $3, updated_at = $4::timestamptz
          WHERE id = $5 AND handle IS NULL AND profile_version = $6 RETURNING id`,
        values: [handle, generatedDisplayName ?? null, nextVersion, now, account.id, account.profileVersion],
        maxRows: 1,
      });
      if (updated.length !== 1) {
        return { outcome: { userId: account.id, skipped: "write_conflict" as const } };
      }
      return mintedHandleResult(account, handle, nextVersion, generatedDisplayName);
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505" || /unique|constraint/iu.test((error as Error).message)) {
      return { outcome: { userId: account.id, skipped: "write_conflict" } };
    }
    throw error;
  }
}

async function postgresMissingHandleCount(env: Env): Promise<number> {
  return authPostgresTransaction(env, "auth.handle.count_missing", async (transaction) => {
    const rows = await transaction.query<QueryResultRow & { count: string | number }>({
      name: "auth_handle_count_missing_v1",
      text: "SELECT count(*) AS count FROM control.auth_users WHERE handle IS NULL",
      maxRows: 1,
    });
    return Number(rows[0]?.count ?? 0);
  });
}

/** Write the account row, then publish it. Order matters; see `syncHumanProfile`. */
async function mintAndPublish(
  env: Env,
  account: MintableAccount,
  now: string,
): Promise<HumanHandleMintOutcome> {
  const { outcome, profile } = authAuthority(env) === "postgres"
    ? await postgresMintHandleForAccount(env, account, now)
    : await mintHandleForAccount(env.AUTH_DB!, account, now);
  if (profile) await syncHumanProfile(env, profile, now);
  return outcome;
}

/**
 * Give a freshly created account its address.
 *
 * Swallows everything: this runs inside the account-creation hook, where a
 * throw becomes a failed sign-up. Being briefly unaddressable is recoverable
 * — the person can set a handle themselves and the backfill sweeps the rest —
 * and not having an account at all is not.
 */
export async function mintHandleForNewAccount(env: Env, userId: string): Promise<void> {
  try {
    const account = authAuthority(env) === "postgres"
      ? await postgresAccount(env, userId)
      : await env.AUTH_DB?.prepare(
          `SELECT ${ACCOUNT_COLUMNS} FROM "user" WHERE "id" = ? LIMIT 1`,
        ).bind(userId).first<MintableAccount>();
    if (!account) return;
    await mintAndPublish(env, account, new Date().toISOString());
  } catch {
    // Intentionally silent; see above.
  }
}

export interface HumanHandleBackfillReport {
  scanned: number;
  minted: number;
  skipped: HumanHandleMintOutcome[];
  /** True while accounts without a handle remain, so the operator runs it again. */
  hasMore: boolean;
}

/**
 * Mint handles for one bounded page of accounts that predate the handle field.
 *
 * Bounded and re-runnable rather than a single sweep: a Worker invocation has
 * a wall-clock budget, and the candidate list being pure means a second run
 * resumes exactly where this one stopped without re-deciding anything it
 * already decided. `hasMore` is what tells the operator to go again.
 *
 * Accounts are processed one at a time, not concurrently. Two accounts whose
 * names produce the same first candidate must see each other's write, and
 * concurrency here would make which one wins depend on timing.
 */
export async function backfillHumanHandles(
  env: Env,
  limit: number,
): Promise<HumanHandleBackfillReport> {
  if (authAuthority(env) === "d1" && !env.AUTH_DB) {
    return { scanned: 0, minted: 0, skipped: [], hasMore: false };
  }
  const accounts = authAuthority(env) === "postgres"
    ? await postgresAccountsWithoutHandle(env, limit)
    : await accountsWithoutHandle(env.AUTH_DB!, limit);
  const now = new Date().toISOString();
  const skipped: HumanHandleMintOutcome[] = [];
  let minted = 0;

  for (const account of accounts) {
    const outcome = await mintAndPublish(env, account, now);
    if (outcome.handle) minted += 1;
    else skipped.push(outcome);
  }

  const remaining = authAuthority(env) === "postgres"
    ? await postgresMissingHandleCount(env)
    : (await env.AUTH_DB!.prepare(
        'SELECT COUNT(*) AS count FROM "user" WHERE "handle" IS NULL',
      ).first<{ count: number }>())?.count ?? 0;
  return {
    scanned: accounts.length,
    minted,
    skipped,
    hasMore: remaining > skipped.length,
  };
}
