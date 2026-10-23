import assert from "node:assert/strict";
import { accessTokenSessionAlive, createBetterAuthSessionForUser, revokeBetterAuthSession } from "../src/better-auth.ts";
import { listSignedInSessions, revokeOtherSignedInSessions, revokeSignedInSession } from "../src/auth-sessions.ts";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";

/** An isolated auth database with one or more accounts, and the Hub settings that read it. */
async function authFixture(prefix, users) {
  const f = await isolatedPostgres(prefix, { shard: true });
  const env = { AUTH_AUTHORITY: "postgres", RELAY_POSTGRES: { connectionString: f.url.toString() },
    RELAY_POSTGRES_SHARD_ID: "shard-0", BETTER_AUTH_SECRET: "isolated-fixture-signing-secret-not-production",
    APP_URL: "https://app.revoke.test", HUB_URL: "https://auth.revoke.test" };
  for (const id of users) {
    await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at,handle)
      VALUES ($1,$1,$1||'@example.test',true,now(),now(),$1)`, [id]);
  }
  return { f, env };
}

// Access tokens are checked by signature for their hour; what ends a signed-out
// session's reach is that no route turns its leftover token into a new session.
integration("signing out ends the session, and its leftover access token no longer counts as live", async () => {
  const { f, env } = await authFixture("auth_revoke", ["signer"]);
  try {
    const user = { id: "signer", email: "signer@example.test", name: "signer" };
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

integration("a person lists their sessions, ends one of their own, and ends the others by kind", async () => {
  const { f, env } = await authFixture("auth_sessions", ["owner", "other"]);
  try {
    const session = (id, user, userAgent, expires = "30 days") => f.run(`INSERT INTO control.auth_sessions
      (id,expires_at,token,created_at,updated_at,user_id,user_agent)
      VALUES ($1,now()+$4::interval,$1||'-token',now(),now(),$2,$3)`, [id, user, userAgent, expires]);
    await session("current", "owner", "Mozilla/5.0 (Macintosh) Chrome/140");
    await session("phone", "owner", "Mozilla/5.0 (iPhone) AppleWebKit");
    await session("app", "owner", "xMatrix app");
    await session("cli", "owner", "xMatrix CLI · xmatrix/1.0.556");
    await session("legacy", "owner", null);
    await session("gone", "owner", "Mozilla/5.0", "-1 day");
    await session("theirs", "other", "Mozilla/5.0");

    const listed = await listSignedInSessions(env, "owner", "current");
    assert.equal(listed.total, 5, "expired sessions are not listed");
    assert.equal(listed.sessions[0].id, "current");
    assert.equal(listed.sessions[0].current, true);
    assert.equal(listed.sessions.some(({ id }) => id === "theirs"), false);

    assert.equal(await revokeSignedInSession(env, "owner", "theirs"), false, "another person's session is not mine to end");
    assert.equal(await revokeSignedInSession(env, "owner", "phone"), true);
    // Other browsers and apps go (the app's, and an expired browser's row with them);
    // terminals, daemons and older unlabelled sessions stay.
    assert.equal(await revokeOtherSignedInSessions(env, "owner", "current", "browsers"), 2);
    assert.deepEqual((await listSignedInSessions(env, "owner", "current")).sessions.map(({ id }) => id).sort(),
      ["cli", "current", "legacy"]);
    assert.equal(await revokeOtherSignedInSessions(env, "owner", "current", "everything"), 2);
    assert.deepEqual((await listSignedInSessions(env, "owner", "current")).sessions.map(({ id }) => id), ["current"]);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions WHERE user_id='other'"))[0].n, 1);
  } finally { await f.close(); }
});
