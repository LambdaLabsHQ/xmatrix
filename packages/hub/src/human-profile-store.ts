import type { HumanProfile } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";

import { authAuthority, authPostgresTransaction, requireAuthD1 } from "./auth-authority";
import type { Env } from "./types";

/**
 * The account row behind a Human Profile, and the projection from it.
 *
 * Shared because the profile route and the avatar route are the same write with
 * different columns: read the row, bump `profileVersion` under a compare-and-set,
 * project a `HumanProfile`. Two copies of that projection would be two places
 * for it to drift, which is exactly the failure `human-profile.ts` documents —
 * Authority speaking one field set while clients read another, with a fixture
 * quietly normalising between them.
 *
 * Publishing to Authority lives in `human-profile-sync.ts`, which the account
 * creation hook also reaches; this module stays free of Authority imports.
 */
export type StoredProfile = {
  id: string;
  name: string;
  image: string | null;
  handle: string | null;
  bio: string | null;
  timeZone: string | null;
  profileVersion: number;
};

const SELECT_D1_PROFILE =
  'SELECT "id", "name", "image", "handle", "bio", "timeZone", "profileVersion" ' +
  'FROM "user" WHERE "id" = ? LIMIT 1';

export async function readStoredProfile(env: Env, userId: string): Promise<StoredProfile | null> {
  if (authAuthority(env) === "d1") {
    return requireAuthD1(env).prepare(SELECT_D1_PROFILE).bind(userId).first<StoredProfile>();
  }
  return authPostgresTransaction(env, "auth.profile.read", async (transaction) => {
    const rows = await transaction.query<QueryResultRow & StoredProfile>({
      name: "auth_profile_read_v1",
      text: `SELECT id, name, image, handle, bio, time_zone AS "timeZone",
          profile_version::int AS "profileVersion"
        FROM control.auth_users WHERE id = $1 LIMIT 1`,
      values: [userId], maxRows: 1,
    });
    return rows[0] ?? null;
  });
}

export async function updateStoredAvatar(
  env: Env,
  userId: string,
  avatarUrl: string | null,
  expectedVersion: number,
  nextVersion: number,
  now: string,
): Promise<boolean> {
  if (authAuthority(env) === "d1") {
    const updated = await requireAuthD1(env).prepare(
      `UPDATE "user" SET "image" = ?, "profileVersion" = ?, "updatedAt" = ?
       WHERE "id" = ? AND "profileVersion" = ?`,
    ).bind(avatarUrl, nextVersion, now, userId, expectedVersion).run();
    return (updated.meta.changes ?? 0) === 1;
  }
  return authPostgresTransaction(env, "auth.profile.update_avatar", async (transaction) => {
    const rows = await transaction.query<QueryResultRow>({
      name: "auth_profile_update_avatar_v1",
      text: `UPDATE control.auth_users SET image = $1, profile_version = $2, updated_at = $3::timestamptz
        WHERE id = $4 AND profile_version = $5 RETURNING id`,
      values: [avatarUrl, nextVersion, now, userId, expectedVersion], maxRows: 1,
    });
    return rows.length === 1;
  });
}

export type StoredProfileUpdateResult =
  | "updated"
  | "handle_retired_by_other"
  | "handle_change_rate_limited"
  | "profile_version_conflict"
  | "handle_taken";

export async function updateStoredProfile(
  env: Env,
  input: {
    userId: string;
    currentHandle: string | null;
    expectedVersion: number;
    displayName: string;
    avatarUrl: string | null;
    handle: string;
    bio: string | null;
    timeZone: string | null;
    nextVersion: number;
    now: string;
    retiredSince: string;
  },
): Promise<StoredProfileUpdateResult> {
  if (authAuthority(env) === "d1") return updateD1Profile(requireAuthD1(env), input);
  try {
    return await authPostgresTransaction(env, "auth.profile.update", async (transaction) => {
      if (input.currentHandle !== input.handle) {
        const retired = await transaction.query<QueryResultRow & { userId: string }>({
          name: "auth_profile_retired_owner_v1",
          text: `SELECT user_id AS "userId" FROM control.retired_human_handles
            WHERE lower(handle) = lower($1) LIMIT 1`,
          values: [input.handle], maxRows: 1,
        });
        if (retired[0] && retired[0].userId !== input.userId) return "handle_retired_by_other";
        const recent = await transaction.query<QueryResultRow>({
          name: "auth_profile_retired_recent_v1",
          text: `SELECT handle FROM control.retired_human_handles
            WHERE user_id = $1 AND retired_at >= $2::timestamptz LIMIT 2`,
          values: [input.userId, input.retiredSince], maxRows: 2,
        });
        if (recent.length >= 2) return "handle_change_rate_limited";
        if (input.currentHandle) {
          await transaction.query({
            name: "auth_profile_retire_handle_v1",
            text: `INSERT INTO control.retired_human_handles (handle, user_id, retired_at)
              VALUES ($1, $2, $3::timestamptz) ON CONFLICT DO NOTHING`,
            values: [input.currentHandle, input.userId, input.now], maxRows: 0,
          });
        }
      }
      const rows = await transaction.query<QueryResultRow>({
        name: "auth_profile_update_v1",
        text: `UPDATE control.auth_users SET name = $1, image = $2, handle = $3, bio = $4,
          time_zone = $5, profile_version = $6,
          profile_completed_at = $7::timestamptz, updated_at = $7::timestamptz
          WHERE id = $8 AND profile_version = $9 RETURNING id`,
        values: [input.displayName, input.avatarUrl, input.handle, input.bio, input.timeZone,
          input.nextVersion, input.now, input.userId, input.expectedVersion],
        maxRows: 1,
      });
      return rows.length === 1 ? "updated" : "profile_version_conflict";
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505" || /unique|constraint/iu.test((error as Error).message)) {
      return "handle_taken";
    }
    throw error;
  }
}

async function updateD1Profile(
  database: D1Database,
  input: Parameters<typeof updateStoredProfile>[1],
): Promise<StoredProfileUpdateResult> {
  if (input.currentHandle !== input.handle) {
    const retired = await database.prepare(
      'SELECT "userId" FROM "retired_human_handle" WHERE "handle" = ? COLLATE NOCASE LIMIT 1',
    ).bind(input.handle).first<{ userId: string }>();
    if (retired && retired.userId !== input.userId) return "handle_retired_by_other";
    const recent = await database.prepare(
      'SELECT COUNT(*) AS count FROM "retired_human_handle" WHERE "userId" = ? AND "retiredAt" >= ?',
    ).bind(input.userId, input.retiredSince).first<{ count: number }>();
    if ((recent?.count ?? 0) >= 2) return "handle_change_rate_limited";
  }
  const statements: D1PreparedStatement[] = [];
  if (input.currentHandle !== input.handle && input.currentHandle) statements.push(database.prepare(
    'INSERT OR IGNORE INTO "retired_human_handle" ("handle", "userId", "retiredAt") VALUES (?, ?, ?)',
  ).bind(input.currentHandle, input.userId, input.now));
  statements.push(database.prepare(
    `UPDATE "user" SET "name" = ?, "image" = ?, "handle" = ?, "bio" = ?, "timeZone" = ?,
      "profileVersion" = ?, "profileCompletedAt" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "profileVersion" = ?`,
  ).bind(input.displayName, input.avatarUrl, input.handle, input.bio, input.timeZone,
    input.nextVersion, input.now, input.now, input.userId, input.expectedVersion));
  try {
    const results = await database.batch(statements);
    return (results.at(-1)?.meta.changes ?? 0) === 1 ? "updated" : "profile_version_conflict";
  } catch (error) {
    if (/unique|constraint/iu.test((error as Error).message)) return "handle_taken";
    throw error;
  }
}

/**
 * The public projection of a stored row. `overrides` carries the columns a
 * particular write changed, so a caller never rebuilds the whole shape and
 * cannot forget a field while doing it. `avatarUrl: null` clears the photo;
 * omitting it keeps whatever the row already holds.
 */
export function humanProfileFromStored(
  userId: string,
  stored: StoredProfile,
  overrides: { avatarUrl?: string | null; profileVersion: number },
): HumanProfile {
  const avatarUrl = overrides.avatarUrl === undefined ? stored.image : overrides.avatarUrl;
  return {
    identityId: `user:${userId}`,
    userId,
    displayName: stored.name,
    ...(stored.handle ? { handle: stored.handle } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(stored.bio ? { bio: stored.bio } : {}),
    ...(stored.timeZone ? { timeZone: stored.timeZone } : {}),
    profileVersion: overrides.profileVersion,
  };
}
