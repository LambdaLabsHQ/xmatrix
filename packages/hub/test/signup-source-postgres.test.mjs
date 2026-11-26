import assert from "node:assert/strict";
import { recordSignupSource, SIGNUP_SOURCE_WINDOW_HOURS } from "../src/signup-source.ts";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";

async function fixture(users) {
  const f = await isolatedPostgres("signup_source", { shard: true });
  const env = { AUTH_AUTHORITY: "postgres", RELAY_POSTGRES: { connectionString: f.url.toString() },
    RELAY_POSTGRES_SHARD_ID: "shard-0" };
  for (const [id, hoursAgo] of users) {
    await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at,handle)
      VALUES ($1,$1,$1||'@example.test',true,now() - make_interval(hours => $2),now(),$1)`, [id, hoursAgo]);
  }
  return { f, env };
}

integration("a new account's source is recorded once; an old account and a second visit change nothing", async () => {
  const { f, env } = await fixture([["fresh", 0], ["old", SIGNUP_SOURCE_WINDOW_HOURS + 1]]);
  try {
    assert.equal(await recordSignupSource(env, "fresh", { host: "x.com", ref: "x" }), true);
    // The next visit came from somewhere else: the first answer stays.
    assert.equal(await recordSignupSource(env, "fresh", { host: "google.com", ref: null }), false);
    // An account from before the window is not asked how it found xMatrix.
    assert.equal(await recordSignupSource(env, "old", { host: "v2ex.com", ref: null }), false);
    assert.equal(await recordSignupSource(env, "missing", { host: "direct", ref: null }), false);
    assert.deepEqual(
      await f.run("SELECT id, signup_source_host, signup_source_ref FROM control.auth_users ORDER BY id"),
      [{ id: "fresh", signup_source_host: "x.com", signup_source_ref: "x" },
        { id: "old", signup_source_host: null, signup_source_ref: null }]);
    // The columns refuse anything but a short domain and a short tag.
    await assert.rejects(f.run("UPDATE control.auth_users SET signup_source_host = 'https://x.com/a' WHERE id = 'old'"));
    await assert.rejects(f.run("UPDATE control.auth_users SET signup_source_ref = 'has space' WHERE id = 'old'"));
  } finally {
    await f.close();
  }
});
