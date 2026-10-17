import assert from "node:assert/strict";
import { accessTokenSessionAlive, createBetterAuthSessionForUser, revokeBetterAuthSession } from "../src/better-auth.ts";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";

// Access tokens are checked by signature for their hour; what ends a signed-out
// session's reach is that no route turns its leftover token into a new session.
integration("signing out ends the session, and its leftover access token no longer counts as live", async () => {
  const f = await isolatedPostgres("auth_revoke", { shard: true });
  try {
    const env = { AUTH_AUTHORITY: "postgres", RELAY_POSTGRES: { connectionString: f.url.toString() },
      RELAY_POSTGRES_SHARD_ID: "shard-0", BETTER_AUTH_SECRET: "isolated-fixture-signing-secret-not-production",
      APP_URL: "https://app.revoke.test", HUB_URL: "https://auth.revoke.test" };
    await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at,handle)
      VALUES ('signer','Signer','signer@example.test',true,now(),now(),'signer')`);
    const user = { id: "signer", email: "signer@example.test", name: "Signer" };
    const kept = await createBetterAuthSessionForUser(env, user);
    const ended = await createBetterAuthSessionForUser(env, user);
    assert.equal(await accessTokenSessionAlive(env, ended.token), true);

    await revokeBetterAuthSession(env, ended.refreshToken);
    assert.equal(await accessTokenSessionAlive(env, ended.token), false);
    assert.equal(await accessTokenSessionAlive(env, kept.token), true, "only the named session ends");
    // Signing out twice signs out once.
    await revokeBetterAuthSession(env, ended.refreshToken);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions WHERE user_id='signer'"))[0].n, 1);
  } finally { await f.close(); }
});
