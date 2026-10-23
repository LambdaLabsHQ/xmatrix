import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { inTestTransaction, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

const EMAIL = "app-sign-in@example.test";
const base64url = (bytes) => Buffer.from(bytes).toString("base64url");

function pkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

/** The running worker's own database. */
const query = (sql, values = []) => inTestTransaction(tx => tx.query({ text: sql, values }));

/** A browser that has just come back from Google: it holds a session for EMAIL. */
async function signedInCookie(worker) {
  await query(`INSERT INTO control.auth_verifications(id,identifier,value,expires_at,created_at,updated_at)
    VALUES (gen_random_uuid()::text,$1,'135790:0',now()+interval '5 minutes',now(),now())`, [`sign-in-otp-${EMAIL}`]);
  const response = await worker.fetch("/api/auth/sign-in/email-otp", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, otp: "135790" }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers.getSetCookie().map(value => value.split(";", 1)[0]).filter(pair => !pair.endsWith("=")).join("; ");
}

/** Starts a sign-in as the app's sheet would, and returns the flow the Hub will be called back on. */
async function start(worker, { provider = "google", redirectUri = "xmatrix://auth", challenge, state }) {
  const params = new URLSearchParams({ provider, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: "S256", state });
  const response = await worker.fetch(`/api/auth/app/start?${params}`, { redirect: "manual" });
  if (response.status !== 302) return { response };
  const providerUrl = new URL(response.headers.get("location"));
  // The provider's state names Better Auth's stored record, which holds where it will call back.
  const [row] = await query("SELECT value FROM control.auth_verifications WHERE identifier=$1",
    [providerUrl.searchParams.get("state")]);
  const finish = new URL(JSON.parse(row.value).callbackURL);
  return { response, providerUrl, finish: `${finish.pathname}${finish.search}` };
}

test("an app signs in at a provider and redeems its code once, with its own verifier only", async () => {
  const worker = await startPgHubWorker({ vars: {
    BETTER_AUTH_SECRET: "app-sign-in-fixture-secret-not-production",
    GOOGLE_CLIENT_ID: "google-fixture", GOOGLE_CLIENT_SECRET: "google-fixture",
  } });
  try {
    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes(16));
    const started = await start(worker, { challenge, state });
    assert.equal(started.response.status, 302);
    assert.equal(started.providerUrl.origin, "https://accounts.google.com");
    assert.equal(started.providerUrl.searchParams.get("prompt"), "select_account");
    assert.ok(started.response.headers.getSetCookie().length > 0, "the browser keeps the provider state binding");

    const cookie = await signedInCookie(worker);
    const finished = await worker.fetch(started.finish, { headers: { cookie }, redirect: "manual" });
    assert.equal(finished.status, 302);
    const callback = new URL(finished.headers.get("location"));
    assert.equal(`${callback.protocol}//${callback.host}`, "xmatrix://auth");
    assert.equal(callback.searchParams.get("state"), state);
    // The provider sign-in made this account just now, and the app is told so.
    assert.equal(callback.searchParams.get("new_account"), "1");
    const code = callback.searchParams.get("code");
    assert.match(code, /^[a-f0-9]{64}$/u);

    // The provider's answer is handed over once.
    assert.equal((await worker.fetch(started.finish, { headers: { cookie }, redirect: "manual" })).status, 410);

    const redeem = (codeVerifier) => worker.fetch("/api/auth/app/token", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ code, codeVerifier }) });
    // Whoever intercepted the callback lacks the verifier.
    assert.equal((await redeem(pkce().verifier)).status, 400);
    const issued = await redeem(verifier);
    assert.equal(issued.status, 200);
    const session = await issued.json();
    assert.equal(session.user.email, EMAIL);
    assert.ok(session.token && session.refreshToken && session.hubUrl && session.relayUrl);
    // A lost response is answered again with the same session, not a second one.
    assert.equal((await (await redeem(verifier)).json()).refreshToken, session.refreshToken);
  } finally {
    await worker.stop();
  }
});

test("an app's sign-in refused at the provider, or with a foreign callback, gives the app no code", async () => {
  const worker = await startPgHubWorker({ vars: {
    BETTER_AUTH_SECRET: "app-sign-in-fixture-secret-not-production",
    GITHUB_APP_CLIENT_ID: "github-fixture", GITHUB_APP_CLIENT_SECRET: "github-fixture",
  } });
  try {
    const { challenge } = pkce();
    const foreign = await start(worker, { provider: "github", redirectUri: "https://evil.example/callback",
      challenge, state: base64url(randomBytes(16)) });
    assert.equal(foreign.response.status, 400);

    const state = base64url(randomBytes(16));
    const started = await start(worker, { provider: "github", redirectUri: "http://127.0.0.1:53682/callback",
      challenge, state });
    assert.equal(started.response.status, 302);
    assert.equal(started.providerUrl.origin, "https://github.com");
    const refused = await worker.fetch(`${started.finish}&failed=1&error=access_denied`, { redirect: "manual" });
    assert.equal(refused.status, 302);
    assert.equal(refused.headers.get("location"),
      `http://127.0.0.1:53682/callback?error=access_denied&state=${state}`);
  } finally {
    await worker.stop();
  }
});
