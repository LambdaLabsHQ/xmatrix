import { ControlError } from "./control-error.js";
import type { QueryResultRow } from "pg";

import type { AuthorityDatabase } from "./contracts.js";

export class HumanProfileControlError extends ControlError {
  override name = "HumanProfileControlError";
}

export interface PostgresHumanProfile {
  userId: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  bio: string | null;
  timeZone: string | null;
  handleIsTemporary: boolean;
  profileVersion: number;
  updatedAt: string;
}

function result(row: QueryResultRow): Record<string, unknown> {
  return {
    identityId: `user:${String(row.user_id)}`,
    userId: String(row.user_id),
    displayName: String(row.display_name),
    ...(row.handle ? { handle: String(row.handle) } : {}),
    ...(row.avatar_url ? { avatarUrl: String(row.avatar_url) } : {}),
    ...(row.bio ? { bio: String(row.bio) } : {}),
    ...(row.time_zone ? { timeZone: String(row.time_zone) } : {}),
    ...(row.handle_is_temporary ? { handleIsTemporary: true } : {}),
    profileVersion: Number(row.profile_version),
  };
}

export class PostgresHumanProfileRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new HumanProfileControlError(
      "cached_authority_forbidden", 500, "Human Profile authority requires uncached PostgreSQL",
    );
  }

  async publish(profile: PostgresHumanProfile): Promise<{ profile: Record<string, unknown> }> {
    return this.database.transaction({
      requestId: `human-profile:${profile.userId}:${profile.profileVersion}`,
      operation: "human-profile.publish",
    }, async (tx) => {
      await tx.query({ name: "human_profile_publish_v1", text: `INSERT INTO data.human_profiles AS target
        (user_id,display_name,handle,avatar_url,bio,time_zone,
         handle_is_temporary,profile_version,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (user_id) DO UPDATE SET
          display_name=EXCLUDED.display_name,handle=EXCLUDED.handle,avatar_url=EXCLUDED.avatar_url,
          bio=EXCLUDED.bio,time_zone=EXCLUDED.time_zone,
          handle_is_temporary=EXCLUDED.handle_is_temporary,
          profile_version=EXCLUDED.profile_version,updated_at=EXCLUDED.updated_at
        WHERE EXCLUDED.profile_version > target.profile_version`, values: [
        profile.userId, profile.displayName, profile.handle, profile.avatarUrl, profile.bio,
        profile.timeZone, profile.handleIsTemporary, profile.profileVersion, profile.updatedAt,
      ], maxRows: 0 });
      const rows = await tx.query<QueryResultRow>({ name: "human_profile_read_after_publish_v1",
        text: "SELECT * FROM data.human_profiles WHERE user_id=$1 LIMIT 1",
        values: [profile.userId], maxRows: 1 });
      if (!rows[0]) throw new HumanProfileControlError(
        "human_profile_unavailable", 503, "Human Profile was not committed", true,
      );
      return { profile: result(rows[0]) };
    });
  }
}
