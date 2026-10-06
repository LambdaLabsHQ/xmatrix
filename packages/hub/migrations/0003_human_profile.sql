-- Human Profile: the fields a person edits and collaborators read.
--
-- Expand only. Every column added here is optional, because the accounts that
-- already exist have none of them and must keep working untouched while the
-- backfill runs. Nothing reads these yet; switching the read path is a later
-- step, after the data is verified in place.
--
-- `name` and `image` keep carrying displayName and avatar. They are Better
-- Auth's own columns and there is no gain in moving them.

-- The stable `@` address. Nullable because it does not exist yet for anyone;
-- the backfill fills it, and until then every read falls back exactly as it
-- does today.
ALTER TABLE "user" ADD COLUMN "handle" TEXT;

-- Free-text self description. Bounded by the product, not the column.
ALTER TABLE "user" ADD COLUMN "bio" TEXT;

-- Bumped on every profile write. Relay authority keeps its own copy of the public
-- fields and cannot share a transaction with D1, so the version is what makes
-- the sync idempotent: Core applies a higher version and ignores a lower one,
-- which means a retry, a replay, or an out-of-order delivery all converge
-- instead of fighting.
ALTER TABLE "user" ADD COLUMN "profileVersion" INTEGER NOT NULL DEFAULT 0;

-- Null until the person has confirmed the identity they were given. The
-- backfill mints a working neutral handle so nobody is locked out, and this
-- column is what lets the product keep asking, without ever blocking.
ALTER TABLE "user" ADD COLUMN "profileCompletedAt" DATE;

-- Case-insensitive uniqueness, enforced by the database rather than by every
-- caller remembering to canonicalize first. `NOCASE` is ASCII-only in SQLite,
-- which is exactly the alphabet a handle is allowed to use. SQLite treats
-- NULLs as distinct in a UNIQUE index, so the accounts still waiting on the
-- backfill do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS "user_handle_key" ON "user" ("handle" COLLATE NOCASE);

-- A handle someone used to hold. It is never reassigned to anyone else:
-- historical `@mentions` are plain text, so handing a released handle to a new
-- person would silently re-point every old mention at the wrong human — worse
-- than the mention simply going dead. Retained rows can also resolve as an
-- alias back to the original owner.
CREATE TABLE IF NOT EXISTS "retired_human_handle" (
  "handle" TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
  "userId" TEXT NOT NULL,
  "retiredAt" DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS "retired_human_handle_userId_idx" ON "retired_human_handle" ("userId");
