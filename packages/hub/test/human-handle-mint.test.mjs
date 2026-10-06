import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `handle` shipped nullable because nobody had one, and the migration that
 * added it said a backfill would fill it. The backfill was never written, so
 * every account carried `handle IS NULL` while `@` went on resolving display
 * names — which are unique nowhere, and which is how a mention of one person
 * highlighted and notified another.
 *
 * These tests pin the half that was missing: an account gets exactly one
 * address, nobody is handed someone else's, and running the fill twice is the
 * same as running it once.
 */
import {
  accountsWithoutHandle,
  availableHandleForAccount,
  backfillHumanHandles,
  mintHandleForAccount,
} from "../src/human-handle-mint.ts";

const AUTH_SCHEMA = readFileSync(
  fileURLToPath(new URL("../migrations/0001_better_auth_schema.sql", import.meta.url)),
  "utf8",
);
const PROFILE_SCHEMA = readFileSync(
  fileURLToPath(new URL("../migrations/0003_human_profile.sql", import.meta.url)),
  "utf8",
);
const TIME_ZONE_SCHEMA = readFileSync(
  fileURLToPath(new URL("../migrations/0006_human_time_zone.sql", import.meta.url)),
  "utf8",
);

const NOW = "2026-08-19T00:00:00.000Z";

/**
 * D1's surface over real SQLite, running the real migrations. The unique
 * `COLLATE NOCASE` index on `user.handle` is the thing standing between two
 * people and one address, so it has to be the real index under test.
 */
function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bound = [];
      const api = {
        bind(...args) {
          bound.push(...args);
          return api;
        },
        async first() {
          return statement.get(...bound) ?? null;
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async run() {
          const result = statement.run(...bound);
          return { meta: { changes: Number(result.changes ?? 0) } };
        },
      };
      return api;
    },
  };
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(AUTH_SCHEMA);
  db.exec(PROFILE_SCHEMA);
  db.exec(TIME_ZONE_SCHEMA);
  return db;
}

let sequence = 0;
function addAccount(db, { id, name, handle = null, completed = false } = {}) {
  sequence += 1;
  const userId = id || `acct-${String(sequence).padStart(6, "0")}`;
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "image", "createdAt", "updatedAt", "handle", "profileVersion", "profileCompletedAt")
     VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?)`,
  ).run(userId, name, `${userId}@example.com`, NOW, NOW, handle, completed ? NOW : null);
  return userId;
}

function readAccount(db, userId) {
  return db.prepare(
    'SELECT "id", "name", "handle", "profileVersion", "profileCompletedAt" FROM "user" WHERE "id" = ?',
  ).get(userId);
}

function accountRow(db, userId) {
  return db.prepare(
    'SELECT "id", "name", "image", "bio", "profileVersion", "profileCompletedAt" FROM "user" WHERE "id" = ?',
  ).get(userId);
}

test("an account with a usable name gets that name as its address", async () => {
  const db = database();
  const userId = addAccount(db, { id: "acct-9f3a2c", name: "Legend Wang" });

  const { outcome, profile } = await mintHandleForAccount(d1(db), accountRow(db, userId), NOW);

  assert.equal(outcome.handle, "legend-wang");
  assert.equal(readAccount(db, userId).handle, "legend-wang");
  assert.equal(profile.handle, "legend-wang");
  assert.equal(profile.displayName, "Legend Wang");
  assert.equal(profile.identityId, "user:acct-9f3a2c");
  // The version has to move, or Relay authority ignores the row it is sent.
  assert.equal(profile.profileVersion, 1);
  assert.equal(readAccount(db, userId).profileVersion, 1);
});

test("a system-minted handle is marked temporary, a confirmed profile is not", async () => {
  const db = database();
  const fresh = addAccount(db, { id: "acct-9f3a2c", name: "Legend Wang" });
  const confirmed = addAccount(db, { id: "acct-7b1d4e", name: "Yiming Hu", completed: true });

  const minted = await mintHandleForAccount(d1(db), accountRow(db, fresh), NOW);
  const kept = await mintHandleForAccount(d1(db), accountRow(db, confirmed), NOW);

  assert.equal(minted.profile.handleIsTemporary, true);
  // `profileCompletedAt` is the one place that fact is stored, so a person who
  // already finished setup is not told their own handle is a placeholder.
  assert.equal(kept.profile.handleIsTemporary, undefined);
});

test("two people with one name do not get one address", async () => {
  const db = database();
  const first = addAccount(db, { id: "acct-9f3a2c", name: "Legend Wang" });
  const second = addAccount(db, { id: "acct-7b1d4e", name: "Legend Wang" });

  const one = await mintHandleForAccount(d1(db), accountRow(db, first), NOW);
  const two = await mintHandleForAccount(d1(db), accountRow(db, second), NOW);

  assert.equal(one.outcome.handle, "legend-wang");
  assert.equal(two.outcome.handle, "legend-wang-7b1d4e");
  assert.notEqual(one.outcome.handle, two.outcome.handle);
});

test("a name nobody can transcribe still produces an address", async () => {
  const db = database();
  const userId = addAccount(db, { id: "acct-9f3a2c", name: "王力" });

  const { outcome, profile } = await mintHandleForAccount(d1(db), accountRow(db, userId), NOW);

  assert.equal(outcome.handle, "user-9f3a2c");
  // The generated handle never overwrites what collaborators read.
  assert.equal(profile.displayName, "王力");
});

test("an email OTP placeholder becomes one neutral temporary identity", async () => {
  const db = database();
  const userId = addAccount(db, { id: "acct-9f3a2c", name: "legend@example.com" });

  const { outcome, profile } = await mintHandleForAccount(d1(db), accountRow(db, userId), NOW);

  assert.equal(outcome.handle, "user-9f3a2c");
  assert.equal(profile.displayName, "User 9f3a2c");
  assert.equal(profile.handle, "user-9f3a2c");
  assert.equal(profile.handleIsTemporary, true);
  assert.equal(readAccount(db, userId).name, "User 9f3a2c");
});

test("a retired handle is never handed to the next person", async () => {
  // Old mentions are plain text. Reassigning a released handle would silently
  // re-point every one of them at a different human.
  const db = database();
  db.prepare(
    'INSERT INTO "retired_human_handle" ("handle", "userId", "retiredAt") VALUES (?, ?, ?)',
  ).run("legend-wang", "acct-someone-else", NOW);
  const userId = addAccount(db, { id: "acct-9f3a2c", name: "Legend Wang" });

  const { outcome } = await mintHandleForAccount(d1(db), accountRow(db, userId), NOW);

  assert.equal(outcome.handle, "legend-wang-9f3a2c");
});

test("case is not a way to register a second copy of one address", async () => {
  const db = database();
  addAccount(db, { name: "taken", handle: "legend-wang" });
  const userId = addAccount(db, { id: "acct-9f3a2c", name: "LEGEND WANG" });

  const available = await availableHandleForAccount(d1(db), accountRow(db, userId));

  assert.equal(available, "legend-wang-9f3a2c");
});

test("a handle the person chose is left alone", async () => {
  const db = database();
  const userId = addAccount(db, { id: "acct-9f3a2c", name: "Legend Wang", handle: "legend" });

  const { outcome } = await mintHandleForAccount(d1(db), accountRow(db, userId), NOW);

  // The update is guarded on `handle IS NULL`, so this can only ever fill a
  // hole — it can never rename someone.
  assert.equal(outcome.handle, undefined);
  assert.equal(outcome.skipped, "write_conflict");
  assert.equal(readAccount(db, userId).handle, "legend");
});

test("a profile written between the read and the write wins", async () => {
  const db = database();
  const userId = addAccount(db, { id: "acct-9f3a2c", name: "Legend Wang" });
  const stale = accountRow(db, userId);
  db.prepare('UPDATE "user" SET "handle" = ?, "profileVersion" = 4 WHERE "id" = ?')
    .run("chosen-myself", userId);

  const { outcome } = await mintHandleForAccount(d1(db), stale, NOW);

  assert.equal(outcome.skipped, "write_conflict");
  assert.equal(readAccount(db, userId).handle, "chosen-myself");
  assert.equal(readAccount(db, userId).profileVersion, 4);
});

test("running the fill twice is the same as running it once", async () => {
  const db = database();
  const env = { AUTH_DB: d1(db) };
  addAccount(db, { id: "acct-9f3a2c", name: "Legend Wang" });
  addAccount(db, { id: "acct-7b1d4e", name: "Yiming Hu" });

  const first = await backfillHumanHandles(env, 100);
  const after = db.prepare('SELECT "id", "handle", "profileVersion" FROM "user" ORDER BY "id"').all();
  const second = await backfillHumanHandles(env, 100);

  assert.equal(first.minted, 2);
  assert.equal(first.hasMore, false);
  assert.equal(second.scanned, 0);
  assert.equal(second.minted, 0);
  assert.deepEqual(
    db.prepare('SELECT "id", "handle", "profileVersion" FROM "user" ORDER BY "id"').all(),
    after,
    "a second pass must not mint a second handle or move the version again",
  );
});

test("a page smaller than the queue reports that there is more to do", async () => {
  const db = database();
  const env = { AUTH_DB: d1(db) };
  addAccount(db, { name: "Legend Wang" });
  addAccount(db, { name: "Yiming Hu" });
  addAccount(db, { name: "Someone Else" });

  const report = await backfillHumanHandles(env, 2);

  assert.equal(report.scanned, 2);
  assert.equal(report.minted, 2);
  assert.equal(report.hasMore, true);
  assert.equal((await accountsWithoutHandle(d1(db), 100)).length, 1);
});

test("accounts that already have an address are not scanned again", async () => {
  const db = database();
  addAccount(db, { name: "Legend Wang", handle: "legend" });
  addAccount(db, { name: "Yiming Hu" });

  const pending = await accountsWithoutHandle(d1(db), 100);

  assert.equal(pending.length, 1);
  assert.equal(pending[0].name, "Yiming Hu");
});

test("an Authority publish that fails does not cost the account its handle", async () => {
  // D1 is written first and published second on purpose: the version-based
  // sync converges on the next write, but an Authority row for an account that never
  // saved cannot.
  const db = database();
  const env = { AUTH_DB: d1(db) };
  addAccount(db, { id: "acct-9f3a2c", name: "Legend Wang" });

  const report = await backfillHumanHandles(env, 100);

  assert.equal(report.minted, 1, "no RELAY_CORE binding, so every publish failed");
  assert.equal(readAccount(db, "acct-9f3a2c").handle, "legend-wang");
});
