import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrations = await Promise.all([
  "0001_better_auth_schema.sql",
  "0002_signup_invites.sql",
  "0003_human_profile.sql",
  "0004_auth_postgres_shadow_outbox.sql",
].map((name) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")));

function database() {
  const value = new DatabaseSync(":memory:");
  value.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) value.exec(migration);
  return value;
}

test("Auth outbox migration installs complete change capture", () => {
  const db = database();
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'auth_postgres_shadow_%' ORDER BY name",
  ).all();
  assert.equal(triggers.length, 24);

  db.exec(`
    INSERT INTO "user" ("id", "name", "email", "createdAt", "updatedAt")
      VALUES ('user-1', 'One', 'one@example.com', 1787961600123, 1787961600123);
    INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
      VALUES ('session-1', 1787965200123, 'secret-token', 1787961600123, 1787961600123, 'user-1');
    INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
      VALUES ('account-1', 'one', 'credential', 'user-1', 1787961600123, 1787961600123);
    INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
      VALUES ('verification-1', 'one@example.com', 'otp', 1787965200123, 1787961600123, 1787961600123);
    INSERT INTO "jwks" ("id", "publicKey", "privateKey", "createdAt")
      VALUES ('jwks-1', 'public', 'private', 1787961600123);
    INSERT INTO "signup_invite_code" ("code", "maxUses", "createdAt")
      VALUES ('invite-1', 1, 1787961600123);
    INSERT INTO "signup_invite_claim" ("email", "code", "claimedAt", "expiresAt")
      VALUES ('one@example.com', 'invite-1', 1787961600123, 1787965200123);
    INSERT INTO "retired_human_handle" ("handle", "userId", "retiredAt")
      VALUES ('old-one', 'user-1', 1787961600123);
  `);

  const inserts = db.prepare(
    'SELECT "sourceTable", "operation" FROM "auth_postgres_shadow_events" ORDER BY "eventSeq"',
  ).all();
  assert.deepEqual(inserts.map((row) => row.sourceTable), [
    "user", "session", "account", "verification", "jwks",
    "signup_invite_code", "signup_invite_claim", "retired_human_handle",
  ]);
  assert.equal(inserts.every((row) => row.operation === "upsert"), true);

  db.exec('DELETE FROM "auth_postgres_shadow_events"');
  db.exec(`
    UPDATE "user" SET "name" = 'One Updated' WHERE "id" = 'user-1';
    UPDATE "verification" SET "id" = 'verification-2' WHERE "id" = 'verification-1';
    DELETE FROM "jwks" WHERE "id" = 'jwks-1';
  `);
  assert.deepEqual(db.prepare(
    'SELECT "sourceTable", "sourceKey", "operation" FROM "auth_postgres_shadow_events" ORDER BY "eventSeq"',
  ).all().map((row) => ({ ...row })), [
    { sourceTable: "user", sourceKey: "user-1", operation: "upsert" },
    { sourceTable: "verification", sourceKey: "verification-1", operation: "delete" },
    { sourceTable: "verification", sourceKey: "verification-2", operation: "upsert" },
    { sourceTable: "jwks", sourceKey: "jwks-1", operation: "delete" },
  ]);
});
