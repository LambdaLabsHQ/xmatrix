-- One-way source fence for the Auth authority cutover. The row starts in
-- shadow, so applying this expand migration changes no product behavior.
CREATE TABLE IF NOT EXISTS "auth_authority_control" (
  "domain" TEXT PRIMARY KEY NOT NULL CHECK ("domain" = 'auth'),
  "phase" TEXT NOT NULL CHECK ("phase" IN ('shadow', 'fenced')),
  "fencedAt" DATE,
  "appRevision" TEXT
);

INSERT OR IGNORE INTO "auth_authority_control" ("domain", "phase") VALUES ('auth', 'shadow');

CREATE TRIGGER IF NOT EXISTS "auth_fence_user_insert" BEFORE INSERT ON "user"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_user_update" BEFORE UPDATE ON "user"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_user_delete" BEFORE DELETE ON "user"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;

CREATE TRIGGER IF NOT EXISTS "auth_fence_session_insert" BEFORE INSERT ON "session"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_session_update" BEFORE UPDATE ON "session"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_session_delete" BEFORE DELETE ON "session"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;

CREATE TRIGGER IF NOT EXISTS "auth_fence_account_insert" BEFORE INSERT ON "account"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_account_update" BEFORE UPDATE ON "account"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_account_delete" BEFORE DELETE ON "account"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;

CREATE TRIGGER IF NOT EXISTS "auth_fence_verification_insert" BEFORE INSERT ON "verification"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_verification_update" BEFORE UPDATE ON "verification"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_verification_delete" BEFORE DELETE ON "verification"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;

CREATE TRIGGER IF NOT EXISTS "auth_fence_jwks_insert" BEFORE INSERT ON "jwks"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_jwks_update" BEFORE UPDATE ON "jwks"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_jwks_delete" BEFORE DELETE ON "jwks"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;

CREATE TRIGGER IF NOT EXISTS "auth_fence_invite_code_insert" BEFORE INSERT ON "signup_invite_code"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_invite_code_update" BEFORE UPDATE ON "signup_invite_code"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_invite_code_delete" BEFORE DELETE ON "signup_invite_code"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;

CREATE TRIGGER IF NOT EXISTS "auth_fence_invite_claim_insert" BEFORE INSERT ON "signup_invite_claim"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_invite_claim_update" BEFORE UPDATE ON "signup_invite_claim"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_invite_claim_delete" BEFORE DELETE ON "signup_invite_claim"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;

CREATE TRIGGER IF NOT EXISTS "auth_fence_retired_handle_insert" BEFORE INSERT ON "retired_human_handle"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_retired_handle_update" BEFORE UPDATE ON "retired_human_handle"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
CREATE TRIGGER IF NOT EXISTS "auth_fence_retired_handle_delete" BEFORE DELETE ON "retired_human_handle"
WHEN (SELECT "phase" FROM "auth_authority_control" WHERE "domain" = 'auth') = 'fenced'
BEGIN SELECT RAISE(ABORT, 'auth_source_fenced'); END;
