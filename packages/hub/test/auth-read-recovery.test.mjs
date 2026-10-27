import assert from "node:assert/strict";
import { Client } from "pg";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";
import { verifyAuthToken } from "../src/auth.ts";
import { getBetterAuthPublicKey } from "../src/auth-jwks-cache.ts";
import { authDirectoryEmails, authUserByGitHubId, authHasGitHubAccount,
  authDirectoryAdminUsers } from "../src/auth-authority.ts";
import { listSignedInSessions } from "../src/auth-sessions.ts";
import { accessTokenSessionAlive } from "../src/better-auth.ts";
import { readStoredProfile } from "../src/human-profile-store.ts";
import { backfillHumanHandles, mintHandleForNewAccount } from "../src/human-handle-mint.ts";

// Healthy cache tests cannot catch a lost PostgreSQL response. Run the real
// client, SQL and JWT verifier; the fault only drops a completed SELECT's result.
integration("Auth reads recover one lost response and keep authentication failures distinct (XMATRIX-HUB-AT)", async t => {
  const f = await isolatedPostgres("auth_read_recovery");
  const keys = await generateKeyPair("ES256");
  const publicKey = JSON.stringify(await exportJWK(keys.publicKey));
  const env = { AUTH_AUTHORITY: "postgres", RELAY_POSTGRES_SHARD_ID: "shard-0",
    RELAY_POSTGRES: { connectionString: f.url.toString() }, HUB_URL: "https://auth.example.test" };
  const freshEnv = () => ({ ...env, RELAY_POSTGRES: { ...env.RELAY_POSTGRES } });
  const token = await new SignJWT({ email: "recovery@example.test", auth_session_id: "session" })
    .setProtectedHeader({ alg: "ES256", kid: "key" }).setSubject("person")
    .setIssuer(env.HUB_URL).setAudience(env.HUB_URL).setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
  let fault;
  const queries = [], ended = new Set();
  const query = Client.prototype.query, end = Client.prototype.end;
  try {
    await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,handle,created_at,updated_at)
      VALUES('person','Recovery','recovery@example.test',true,'recovery',now(),now())`);
    await f.run(`INSERT INTO control.auth_sessions(id,token,user_id,expires_at,created_at,updated_at)
      VALUES('session','synthetic-session','person',now()+interval '1 day',now(),now())`);
    await f.run(`INSERT INTO control.auth_jwks(id,public_key,private_key,created_at)
      VALUES('key',$1,'unused',now())`, [publicKey]);
    t.mock.method(Client.prototype, "end", async function (...args) {
      ended.add(this);
      return end.apply(this, args);
    });
    t.mock.method(Client.prototype, "query", async function (input, ...args) {
      if (this.connectionParameters.application_name !== "xmatrix-hub-auth") return query.call(this, input, ...args);
      const text = typeof input === "string" ? input : input.text;
      queries.push({ client: this, text });
      const result = await query.call(this, input, ...args);
      if (fault?.matches.test(text)) {
        if (fault.clients.length) assert.ok(ended.has(fault.clients.at(-1)), "close the lost session before retry");
        fault.clients.push(this);
        if (fault.remaining-- > 0) throw fault.error;
      }
      return result;
    });
    const inject = (remaining, error = new Error("Query read timeout"), matches = /FROM control\.auth_jwks/u) => {
      fault = { remaining, error, matches, clients: [] };
      return fault;
    };
    inject(1);
    assert.equal((await verifyAuthToken(token, freshEnv())).id, "person");
    assert.equal(fault.clients.length, 2);
    assert.notEqual(fault.clients[0], fault.clients[1]);
    assert.ok(fault.clients.every(client => ended.has(client)), "every request connection closes");

    for (const [error, attempts] of [[new Error("Query read timeout"), 2],
      [Object.assign(new Error("statement timeout"), { code: "57014" }), 1]]) {
      const failedEnv = freshEnv();
      inject(3, error);
      await assert.rejects(verifyAuthToken(token, failedEnv), candidate => candidate === error);
      assert.equal(fault.clients.length, attempts, "retry only lost responses, once");
      fault = undefined;
      assert.equal((await verifyAuthToken(token, failedEnv)).id, "person", "failed promises are evicted");
    }
    const missingEnv = freshEnv();
    assert.equal(await getBetterAuthPublicKey(missingEnv, "rotated"), null);
    await f.run(`INSERT INTO control.auth_jwks(id,public_key,private_key,created_at)
      VALUES('rotated',$1,'unused',now())`, [publicKey]);
    assert.ok(await getBetterAuthPublicKey(missingEnv, "rotated"), "unknown keys are not cached");
    const invalid = await new SignJWT({ email: "recovery@example.test" })
      .setProtectedHeader({ alg: "ES256", kid: "key" }).setSubject("person")
      .setIssuer(env.HUB_URL).setAudience(env.HUB_URL).setExpirationTime(1).sign(keys.privateKey);
    inject(1);
    await assert.rejects(verifyAuthToken(invalid, freshEnv()), /Invalid or expired auth token/u);
    assert.equal(fault.clients.length, 2, "recovery still verifies token expiry");
    fault = undefined;

    const now = new Date().toISOString();
    const reads = [
      () => authDirectoryEmails(env, ["person"]),
      () => authUserByGitHubId(env, "synthetic-github-id"),
      () => authHasGitHubAccount(env, "person"),
      () => authDirectoryAdminUsers(env, now, 10),
      () => listSignedInSessions(env, "person", "session"),
      () => accessTokenSessionAlive(env, token),
      () => readStoredProfile(env, "person"),
      () => mintHandleForNewAccount(env, "missing-person"),
    ];
    for (const read of reads) {
      const expected = await read();
      inject(1, new Error("Connection terminated unexpectedly"), /FROM control\.auth_/u);
      assert.deepEqual(await read(), expected);
      assert.equal(fault.clients.length, 2);
      fault = undefined;
    }
    const expected = await backfillHumanHandles(env, 10);
    for (const matches of [/WHERE handle IS NULL ORDER BY/u, /SELECT count\(\*\) AS count/u]) {
      inject(1, new Error("Query read timeout"), matches);
      assert.deepEqual(await backfillHumanHandles(env, 10), expected);
      assert.equal(fault.clients.length, 2);
      fault = undefined;
    }
    assert.ok(queries.every(({ text }) => !/^(BEGIN|COMMIT)/u.test(text)), "independent reads avoid transaction round trips");
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});
