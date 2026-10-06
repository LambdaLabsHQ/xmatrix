CREATE TABLE IF NOT EXISTS "auth_postgres_shadow_events" (
  "eventSeq" INTEGER PRIMARY KEY AUTOINCREMENT,
  "sourceTable" TEXT NOT NULL CHECK ("sourceTable" IN (
    'user', 'session', 'account', 'verification', 'jwks',
    'signup_invite_code', 'signup_invite_claim', 'retired_human_handle'
  )),
  "sourceKey" TEXT NOT NULL,
  "operation" TEXT NOT NULL CHECK ("operation" IN ('upsert', 'delete')),
  "createdAt" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_user_insert"
AFTER INSERT ON "user" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('user', NEW."id", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_user_update"
AFTER UPDATE ON "user" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  SELECT 'user', OLD."id", 'delete' WHERE OLD."id" <> NEW."id";
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('user', NEW."id", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_user_delete"
AFTER DELETE ON "user" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('user', OLD."id", 'delete');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_session_insert"
AFTER INSERT ON "session" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('session', NEW."id", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_session_update"
AFTER UPDATE ON "session" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  SELECT 'session', OLD."id", 'delete' WHERE OLD."id" <> NEW."id";
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('session', NEW."id", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_session_delete"
AFTER DELETE ON "session" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('session', OLD."id", 'delete');
END;

CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_account_insert"
AFTER INSERT ON "account" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('account', NEW."id", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_account_update"
AFTER UPDATE ON "account" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  SELECT 'account', OLD."id", 'delete' WHERE OLD."id" <> NEW."id";
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('account', NEW."id", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_account_delete"
AFTER DELETE ON "account" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('account', OLD."id", 'delete');
END;

CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_verification_insert"
AFTER INSERT ON "verification" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('verification', NEW."id", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_verification_update"
AFTER UPDATE ON "verification" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  SELECT 'verification', OLD."id", 'delete' WHERE OLD."id" <> NEW."id";
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('verification', NEW."id", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_verification_delete"
AFTER DELETE ON "verification" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('verification', OLD."id", 'delete');
END;

CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_jwks_insert"
AFTER INSERT ON "jwks" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('jwks', NEW."id", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_jwks_update"
AFTER UPDATE ON "jwks" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  SELECT 'jwks', OLD."id", 'delete' WHERE OLD."id" <> NEW."id";
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('jwks', NEW."id", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_jwks_delete"
AFTER DELETE ON "jwks" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('jwks', OLD."id", 'delete');
END;

CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_invite_code_insert"
AFTER INSERT ON "signup_invite_code" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('signup_invite_code', NEW."code", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_invite_code_update"
AFTER UPDATE ON "signup_invite_code" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  SELECT 'signup_invite_code', OLD."code", 'delete' WHERE OLD."code" <> NEW."code";
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('signup_invite_code', NEW."code", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_invite_code_delete"
AFTER DELETE ON "signup_invite_code" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('signup_invite_code', OLD."code", 'delete');
END;

CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_invite_claim_insert"
AFTER INSERT ON "signup_invite_claim" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('signup_invite_claim', NEW."email", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_invite_claim_update"
AFTER UPDATE ON "signup_invite_claim" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  SELECT 'signup_invite_claim', OLD."email", 'delete' WHERE OLD."email" <> NEW."email";
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('signup_invite_claim', NEW."email", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_invite_claim_delete"
AFTER DELETE ON "signup_invite_claim" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('signup_invite_claim', OLD."email", 'delete');
END;

CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_retired_handle_insert"
AFTER INSERT ON "retired_human_handle" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('retired_human_handle', NEW."handle", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_retired_handle_update"
AFTER UPDATE ON "retired_human_handle" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  SELECT 'retired_human_handle', OLD."handle", 'delete' WHERE OLD."handle" <> NEW."handle";
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('retired_human_handle', NEW."handle", 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS "auth_postgres_shadow_retired_handle_delete"
AFTER DELETE ON "retired_human_handle" BEGIN
  INSERT INTO "auth_postgres_shadow_events" ("sourceTable", "sourceKey", "operation")
  VALUES ('retired_human_handle', OLD."handle", 'delete');
END;
