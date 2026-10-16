import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createAuth, verifyBetterAuthEmailOtp } from "../src/better-auth.ts";
import { secondFactorPage } from "../src/two-factor.ts";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";

const EMAIL = "reviewer@example.test";

async function fixture() {
  const f = await isolatedPostgres("two_factor", { shard: true });
  const env = {
    AUTH_AUTHORITY: "postgres", RELAY_POSTGRES: { connectionString: f.url.toString() },
    RELAY_POSTGRES_SHARD_ID: "shard-0", BETTER_AUTH_SECRET: "isolated-two-factor-secret-not-production",
    GOOGLE_CLIENT_ID: "fixture", GOOGLE_CLIENT_SECRET: "fixture",
    APP_URL: "https://app.two-factor.test", HUB_URL: "https://hub.two-factor.test",
  };
  const auth = createAuth(env);
  const ip = `2001:db8:${f.suffix.slice(0, 4)}:${f.suffix.slice(4, 8)}::2`;
  const call = (path, { body, cookie } = {}) => auth.handler(new Request(`${env.HUB_URL}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: { origin: env.APP_URL, "cf-connecting-ip": ip, ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at,handle)
    VALUES ('reviewer','Reviewer',$1,true,now(),now(),'reviewer')`, [EMAIL]);
  /** A login code as the mail would carry it; this fixture has no mail binding. */
  const issueLoginCode = async (otp = "246810") => {
    await f.run(`DELETE FROM control.auth_verifications WHERE identifier=$1`, [`sign-in-otp-${EMAIL}`]);
    await f.run(`INSERT INTO control.auth_verifications(id,identifier,value,expires_at,created_at,updated_at)
      VALUES (gen_random_uuid()::text,$1,$2,now()+interval '5 minutes',now(),now())`, [`sign-in-otp-${EMAIL}`, `${otp}:0`]);
    return otp;
  };
  const sessions = async () => (await f.run(
    "SELECT count(*)::int n FROM control.auth_sessions WHERE user_id='reviewer'"))[0].n;
  return { ...f, env, call, issueLoginCode, sessions };
}

const cookiesOf = (response) => response.headers.getSetCookie()
  .map((value) => value.split(";", 1)[0]).filter((pair) => !pair.endsWith("=")).join("; ");

function base32(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text.replace(/=+$/u, "")) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totp(uri) {
  const secret = base32(new URL(uri).searchParams.get("secret"));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function turnOn(f) {
  const signIn = await f.call("/sign-in/email-otp", { body: { email: EMAIL, otp: await f.issueLoginCode() } });
  assert.equal(signIn.status, 200);
  const cookie = cookiesOf(signIn);
  const enabled = await f.call("/two-factor/enable", { body: {}, cookie });
  assert.equal(enabled.status, 200);
  const { totpURI, backupCodes } = await enabled.json();
  assert.equal(backupCodes.length, 10);
  // Turning on takes effect only once the authenticator app proves it has the secret.
  assert.equal((await f.run("SELECT two_factor_enabled FROM control.auth_users WHERE id='reviewer'"))[0].two_factor_enabled, false);
  const confirmed = await f.call("/two-factor/verify-totp", { body: { code: totp(totpURI) }, cookie });
  assert.equal(confirmed.status, 200);
  assert.equal((await f.run("SELECT two_factor_enabled FROM control.auth_users WHERE id='reviewer'"))[0].two_factor_enabled, true);
  return { totpURI, backupCodes };
}

integration("a login code signs in only after the authenticator code once two-step verification is on", async () => {
  const f = await fixture();
  try {
    const { totpURI, backupCodes } = await turnOn(f);
    const before = await f.sessions();

    const firstFactor = await f.call("/sign-in/email-otp", { body: { email: EMAIL, otp: await f.issueLoginCode() } });
    assert.equal(firstFactor.status, 200);
    assert.deepEqual(await firstFactor.json(), { twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    assert.equal(await f.sessions(), before, "the first factor alone issues no session");
    const pending = cookiesOf(firstFactor);
    assert.match(pending, /two_factor=/u);

    assert.equal((await f.call("/two-factor/verify-totp", { body: { code: "000000" }, cookie: pending })).status, 401);
    const second = await f.call("/two-factor/verify-totp", { body: { code: totp(totpURI) }, cookie: pending });
    assert.equal(second.status, 200);
    assert.ok((await second.json()).token);
    assert.equal(await f.sessions(), before + 1);

    // A backup code stands in for the app, once.
    const again = await f.call("/sign-in/email-otp", { body: { email: EMAIL, otp: await f.issueLoginCode() } });
    const backup = await f.call("/two-factor/verify-backup-code", { body: { code: backupCodes[0] }, cookie: cookiesOf(again) });
    assert.equal(backup.status, 200);
    const reuse = await f.call("/sign-in/email-otp", { body: { email: EMAIL, otp: await f.issueLoginCode() } });
    assert.equal((await f.call("/two-factor/verify-backup-code",
      { body: { code: backupCodes[0] }, cookie: cookiesOf(reuse) })).status, 401);

    // The token-returning Hub route has no code step: it refuses rather than issuing a session.
    await f.issueLoginCode("135790");
    await assert.rejects(verifyBetterAuthEmailOtp(f.env, EMAIL, "135790"),
      (error) => error.status === 403 && error.code === "two_factor_required");
  } finally { await f.close(); }
});

integration("a Google sign-in returns to the login page for the code instead of issuing a session", async (t) => {
  const f = await fixture();
  try {
    await turnOn(f);
    const before = await f.sessions();
    const started = await f.call("/sign-in/social", { body: { provider: "google", callbackURL: `${f.env.APP_URL}/app` } });
    assert.equal(started.status, 200);
    const state = new URL((await started.json()).url).searchParams.get("state");
    const idToken = [{ alg: "none", typ: "JWT" }, {
      sub: "google-reviewer", email: EMAIL, email_verified: true, name: "Reviewer",
      iss: "https://accounts.google.com", aud: "fixture", exp: Math.floor(Date.now() / 1000) + 600,
    }].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".";
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "fixture-access", id_token: idToken, token_type: "Bearer", expires_in: 3600 });
      }
      return realFetch(input, init);
    });
    const callback = await f.call(`/callback/google?state=${state}&code=fixture-code`, { cookie: cookiesOf(started) });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), `${f.env.APP_URL}/login?two_factor=1&next=%2Fapp`);
    assert.equal(await f.sessions(), before);
    assert.match(cookiesOf(callback), /two_factor=/u);
  } finally { await f.close(); }
});

test("the code page keeps a login-page sign-in's own parameters and carries any other destination as next", () => {
  const env = { APP_URL: "https://app.example.test" };
  assert.equal(secondFactorPage(env, "https://app.example.test/login?device_code=d&user_code=U"),
    "https://app.example.test/login?device_code=d&user_code=U&two_factor=1");
  assert.equal(secondFactorPage(env, "https://app.example.test/oauth/authorize?client_id=c"),
    "https://app.example.test/login?two_factor=1&next=%2Foauth%2Fauthorize%3Fclient_id%3Dc");
  assert.equal(secondFactorPage(env, "https://elsewhere.example/"), "https://app.example.test/login?two_factor=1");
  assert.equal(secondFactorPage(env, undefined), "https://app.example.test/login?two_factor=1");
});
