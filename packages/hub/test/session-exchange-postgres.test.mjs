import assert from "node:assert/strict";
import { SESSION_EXCHANGE_USER_MISMATCH } from "../src/auth-errors.ts";
import { createBetterAuthSessionForUser } from "../src/better-auth.ts";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";

// A retained CLI JWT is identity proof, not authority to replace a Profile
// saved after that JWT was issued. Exercise the real session/token boundary.
integration("session exchange preserves an existing Human Profile and refuses a different account with the same email", async () => {
  const f = await isolatedPostgres("session_exchange_profile", { shard: true });
  const env = {
    AUTH_AUTHORITY: "postgres", RELAY_POSTGRES: { connectionString: f.url.toString() },
    RELAY_POSTGRES_SHARD_ID: "shard-0", BETTER_AUTH_SECRET: "isolated-session-exchange-fixture-secret",
    APP_URL: "https://app.exchange.test", HUB_URL: "https://hub.exchange.test",
  };
  try {
    await f.run(`INSERT INTO control.auth_users
      (id,name,email,email_verified,image,handle,profile_version,profile_completed_at,created_at,updated_at)
      VALUES ('person','QA Chosen Name','qa@example.test',true,NULL,'qa-chosen',4,now(),now(),now())`);
    const read = async () => (await f.run(`SELECT name,image,handle,profile_version,profile_completed_at,updated_at
      FROM control.auth_users WHERE id='person'`))[0];
    const before = await read();
    const stale = { id: "person", email: "qa@example.test", name: "User old-token",
      avatarUrl: "https://example.test/removed-avatar.png" };
    const exchanged = await createBetterAuthSessionForUser(env, stale);
    assert.deepEqual(await read(), before);
    assert.equal(exchanged.user.name, "QA Chosen Name");
    assert.equal(exchanged.user.avatarUrl, undefined);
    assert.ok(exchanged.token && exchanged.refreshToken);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions"))[0].n, 1);
    await assert.rejects(createBetterAuthSessionForUser(env, { ...stale, id: "different-person" }),
      error => error.message === SESSION_EXCHANGE_USER_MISMATCH);
    assert.deepEqual(await read(), before);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions"))[0].n, 1);
    const created = await createBetterAuthSessionForUser(env,
      { id: "new-person", email: "new@example.test", name: "QA New Person" });
    assert.equal(created.user.name, "QA New Person");
    assert.equal((await f.run("SELECT name FROM control.auth_users WHERE id='new-person'"))[0].name, "QA New Person");
  } finally { await f.close(); }
});
