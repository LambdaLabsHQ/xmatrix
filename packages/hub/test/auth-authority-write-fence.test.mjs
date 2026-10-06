import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrations = [1, 2, 3, 4, 5].map((version) => readFileSync(
  new URL(`../migrations/000${version}_${[
    "better_auth_schema", "signup_invites", "human_profile",
    "auth_postgres_shadow_outbox", "auth_authority_write_fence",
  ][version - 1]}.sql`, import.meta.url),
  "utf8",
));

test("Auth source fence blocks every mutation class after an inert expand", () => {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration);
  const triggers = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'auth_fence_%'",
  ).all();
  assert.equal(triggers.length, 24);

  const now = new Date().toISOString();
  const contracts = [
    {
      table: "user",
      seed: ['INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)',
        ["fence-user", "Fence", "fence@example.com", now, now]],
      insert: ['INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)',
        ["blocked-user", "Blocked", "blocked@example.com", now, now]],
      update: ['UPDATE "user" SET "name" = ? WHERE "id" = ?', ["Changed", "fence-user"]],
      delete: ['DELETE FROM "user" WHERE "id" = ?', ["fence-user"]],
    },
    {
      table: "session",
      seed: ['INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?)',
        ["fence-session", now, "fence-token", now, now, "fence-user"]],
      insert: ['INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?)',
        ["blocked-session", now, "blocked-token", now, now, "fence-user"]],
      update: ['UPDATE "session" SET "userAgent" = ? WHERE "id" = ?', ["changed", "fence-session"]],
      delete: ['DELETE FROM "session" WHERE "id" = ?', ["fence-session"]],
    },
    {
      table: "account",
      seed: ['INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        ["fence-account", "fence-account-id", "test", "fence-user", now, now]],
      insert: ['INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        ["blocked-account", "blocked-account-id", "test", "fence-user", now, now]],
      update: ['UPDATE "account" SET "scope" = ? WHERE "id" = ?', ["changed", "fence-account"]],
      delete: ['DELETE FROM "account" WHERE "id" = ?', ["fence-account"]],
    },
    {
      table: "verification",
      seed: ['INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        ["fence-verification", "fence@example.com", "fence-value", now, now, now]],
      insert: ['INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        ["blocked-verification", "blocked@example.com", "blocked-value", now, now, now]],
      update: ['UPDATE "verification" SET "value" = ? WHERE "id" = ?', ["changed", "fence-verification"]],
      delete: ['DELETE FROM "verification" WHERE "id" = ?', ["fence-verification"]],
    },
    {
      table: "jwks",
      seed: ['INSERT INTO "jwks" ("id", "publicKey", "privateKey", "createdAt") VALUES (?, ?, ?, ?)',
        ["fence-jwks", "fence-public", "fence-private", now]],
      insert: ['INSERT INTO "jwks" ("id", "publicKey", "privateKey", "createdAt") VALUES (?, ?, ?, ?)',
        ["blocked-jwks", "blocked-public", "blocked-private", now]],
      update: ['UPDATE "jwks" SET "publicKey" = ? WHERE "id" = ?', ["changed", "fence-jwks"]],
      delete: ['DELETE FROM "jwks" WHERE "id" = ?', ["fence-jwks"]],
    },
    {
      table: "signup_invite_code",
      seed: ['INSERT INTO "signup_invite_code" ("code", "createdAt") VALUES (?, ?)',
        ["fence-code", now]],
      insert: ['INSERT INTO "signup_invite_code" ("code", "createdAt") VALUES (?, ?)',
        ["blocked-code", now]],
      update: ['UPDATE "signup_invite_code" SET "note" = ? WHERE "code" = ?', ["changed", "fence-code"]],
      delete: ['DELETE FROM "signup_invite_code" WHERE "code" = ?', ["fence-code"]],
    },
    {
      table: "signup_invite_claim",
      seed: ['INSERT INTO "signup_invite_claim" ("email", "code", "claimedAt", "expiresAt") VALUES (?, ?, ?, ?)',
        ["fence@example.com", "fence-code", now, now]],
      insert: ['INSERT INTO "signup_invite_claim" ("email", "code", "claimedAt", "expiresAt") VALUES (?, ?, ?, ?)',
        ["blocked@example.com", "fence-code", now, now]],
      update: ['UPDATE "signup_invite_claim" SET "consumedAt" = ? WHERE "email" = ?', [now, "fence@example.com"]],
      delete: ['DELETE FROM "signup_invite_claim" WHERE "email" = ?', ["fence@example.com"]],
    },
    {
      table: "retired_human_handle",
      seed: ['INSERT INTO "retired_human_handle" ("handle", "userId", "retiredAt") VALUES (?, ?, ?)',
        ["fence-handle", "fence-user", now]],
      insert: ['INSERT INTO "retired_human_handle" ("handle", "userId", "retiredAt") VALUES (?, ?, ?)',
        ["blocked-handle", "fence-user", now]],
      update: ['UPDATE "retired_human_handle" SET "retiredAt" = ? WHERE "handle" = ?', ["later", "fence-handle"]],
      delete: ['DELETE FROM "retired_human_handle" WHERE "handle" = ?', ["fence-handle"]],
    },
  ];
  for (const contract of contracts) database.prepare(contract.seed[0]).run(...contract.seed[1]);
  database.prepare(
    `UPDATE "auth_authority_control" SET "phase" = 'fenced', "fencedAt" = ?, "appRevision" = ?
      WHERE "domain" = 'auth' AND "phase" = 'shadow'`,
  ).run(now, "a".repeat(40));

  for (const contract of contracts) {
    for (const mutation of ["insert", "update", "delete"]) {
      const [sql, values] = contract[mutation];
      assert.throws(
        () => database.prepare(sql).run(...values),
        /auth_source_fenced/u,
        `${contract.table} ${mutation} escaped the Auth source fence`,
      );
    }
  }
});
