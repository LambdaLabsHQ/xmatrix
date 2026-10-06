/**
 * Publishing one Human Profile from the account database to the Relay directory.
 *
 * The account row in D1 and Relay's directory copy cannot share a transaction,
 * so `profileVersion` is what makes them converge: the active directory
 * authority applies a higher version and ignores anything at or below the one
 * it holds.
 * That makes this call safe to retry, to lose, and to deliver out of order.
 *
 * It is therefore always best-effort at the call site. A profile edit, a
 * minted handle, and a backfill all write D1 first and publish second — never
 * the reverse — because an account that exists without its Relay copy
 * converges on the next write, while a Relay copy of an account that failed to
 * save cannot.
 *
 * This lives apart from the routes so the account-creation hook can reach it:
 * `index-shared` imports `better-auth`, so the hook cannot import back through
 * it without a cycle.
 */

import type { HumanProfile } from "@xmatrix/protocol";
import { PostgresHumanProfileRepository } from "@xmatrix/db";

import { postgresAuthorityDatabase } from "./postgres-authority-http";
import type { Env } from "./types";

/** Whether the directory accepted the profile. Never throws: callers treat it as a hint. */
export async function syncHumanProfile(
  env: Env,
  profile: HumanProfile,
  updatedAt: string,
): Promise<boolean> {
  try {
    await new PostgresHumanProfileRepository(postgresAuthorityDatabase(
      env, "Human Profile", "xmatrix-hub-human-profile",
    )).publish({
      userId: profile.userId,
      displayName: profile.displayName,
      handle: profile.handle ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      bio: profile.bio ?? null,
      timeZone: profile.timeZone ?? null,
      handleIsTemporary: profile.handleIsTemporary === true,
      profileVersion: profile.profileVersion,
      updatedAt,
    });
    return true;
  } catch {
    return false;
  }
}
