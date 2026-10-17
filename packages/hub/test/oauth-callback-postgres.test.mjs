import assert from "node:assert/strict";
import test from "node:test";
import { createAuth } from "../src/better-auth.ts";
import { logBetterAuthHandlerMetrics } from "../src/auth-observability.ts";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";

async function fixture() {
  const f = await isolatedPostgres("oauth_callback", { shard: true });
  const env = {
    AUTH_AUTHORITY: "postgres", RELAY_POSTGRES: { connectionString: f.url.toString() },
    RELAY_POSTGRES_SHARD_ID: "shard-0", BETTER_AUTH_SECRET: "isolated-oauth-fixture-secret-not-production",
    GOOGLE_CLIENT_ID: "fixture", GOOGLE_CLIENT_SECRET: "fixture",
    GITHUB_APP_CLIENT_ID: "github-fixture", GITHUB_APP_CLIENT_SECRET: "github-fixture",
    APP_URL: "https://app.oauth.test", HUB_URL: "https://hub.oauth.test",
  };
  const auth = createAuth(env);
  const call = (path, { body, cookie } = {}) => auth.handler(new Request(`${env.HUB_URL}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: { origin: env.APP_URL, ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  return { ...f, env, call };
}

async function metrics(t, path, response) {
  const log = t.mock.method(console, "log", () => {});
  try {
    await logBetterAuthHandlerMetrics(path, response);
    return log.mock.calls.map(({ arguments: args }) => JSON.parse(args[0]));
  } finally { log.mock.restore(); }
}

for (const provider of ["google", "github"]) {
  integration(`${provider}: missing OAuth verification returns to login without creating a session or recording success`, async (t) => {
    const f = await fixture();
    try {
      const response = await f.call(`/callback/${provider}?state=unknown-fixture-state&code=private-fixture-code`);
      const logged = await metrics(t, `/api/auth/callback/${provider}`, response);
      assert.equal(logged[0].outcome, "error");
      assert.equal(logged.some(({ routeGroup }) => routeGroup === "session_created"), false);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), `${f.env.APP_URL}/login?error=state_mismatch`);
      assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions"))[0].n, 0);
      assert.equal(JSON.stringify(logged).includes("private-fixture-code"), false);
    } finally { await f.close(); }
  });

  integration(`${provider}: a parsed OAuth state retains its validated error return, while a replay uses the login fallback`, async (t) => {
    const f = await fixture();
    try {
      const started = await f.call("/sign-in/social", { body: {
        provider, callbackURL: `${f.env.APP_URL}/app`,
        errorCallbackURL: `${f.env.APP_URL}/login?from=fixture`,
      } });
      assert.equal(started.status, 200);
      const state = new URL((await started.json()).url).searchParams.get("state");
      assert.ok(state);
      const cookie = started.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
      const path = `/callback/${provider}?state=${state}&error=access_denied`;
      const denied = await f.call(path, { cookie });
      assert.equal(denied.headers.get("location"), `${f.env.APP_URL}/login?from=fixture&error=access_denied`);
      assert.equal((await metrics(t, `/api/auth/callback/${provider}`, denied))[0].outcome, "error");
      assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_verifications"))[0].n, 0);
      const replay = await f.call(path, { cookie });
      assert.equal(replay.headers.get("location"), `${f.env.APP_URL}/login?error=state_mismatch`);
      assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions"))[0].n, 0);
    } finally { await f.close(); }
  });

  integration(`${provider}: OAuth can return after six minutes; missing, mismatched, replayed and expired state still refuse`, async (t) => {
    const f = await fixture();
    try {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      const start = () => f.call("/sign-in/social", { body: {
        provider, callbackURL: `${f.env.APP_URL}/app`,
        errorCallbackURL: `${f.env.APP_URL}/login`,
      } });
      const started = await start();
      assert.equal(started.status, 200);
      const state = new URL((await started.json()).url).searchParams.get("state");
      const path = `/callback/${provider}?state=${state}&error=access_denied`;
      const other = await start();
      assert.equal(other.status, 200);
      const otherState = new URL((await other.json()).url).searchParams.get("state");
      const otherCookie = other.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
      for (const cookie of [undefined, otherCookie]) {
        const rejected = await f.call(path, { cookie });
        assert.equal(rejected.headers.get("location"), `${f.env.APP_URL}/login?error=state_mismatch`);
      }
      // Apply the actual response's cookie lifetime as a browser does. The
      // provider's denial avoids a token exchange but still validates state.
      const elapsedSeconds = 6 * 60;
      t.mock.timers.tick(elapsedSeconds * 1_000);
      const cookie = started.headers.getSetCookie().filter(value => {
        const maxAge = /;\s*Max-Age=(\d+)/iu.exec(value);
        assert.ok(maxAge, "OAuth cookies must have a bounded lifetime");
        return Number(maxAge[1]) > elapsedSeconds;
      }).map(value => value.split(";", 1)[0]).join("; ");
      const denied = await f.call(path, { cookie });
      assert.equal(denied.headers.get("location"), `${f.env.APP_URL}/login?error=access_denied`);
      const replay = await f.call(path, { cookie });
      assert.equal(replay.headers.get("location"), `${f.env.APP_URL}/login?error=state_mismatch`);
      t.mock.timers.tick((4 * 60 + 1) * 1_000);
      const expired = await f.call(`/callback/${provider}?state=${otherState}&error=access_denied`, { cookie: otherCookie });
      assert.equal(expired.headers.get("location"), `${f.env.APP_URL}/login?error=state_mismatch`);
      assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions"))[0].n, 0);
    } finally { t.mock.timers.reset(); await f.close(); }
  });

}

test("OAuth session metrics require a newly issued session cookie and never log redirect inputs", async (t) => {
  for (const provider of ["google", "github"]) {
    for (const prefix of ["better-auth", "__Secure-xmatrix-test"]) {
      const response = new Response(null, { status: 302, headers: {
        location: "https://app.oauth.test/app", "set-cookie": `${prefix}.session_token=private-session; Path=/; HttpOnly`,
      } });
      const logged = await metrics(t, `/api/auth/callback/${provider}`, response);
      assert.deepEqual(logged.filter(({ routeGroup }) => routeGroup === "session_created").map(({ outcome }) => outcome), [`${provider}_callback`]);
      assert.equal(JSON.stringify(logged).includes("private-session"), false);
    }
    for (const cookie of ["better-auth.state=; Max-Age=0", "better-auth.session_token=; Max-Age=0"]) {
      const response = new Response(null, { status: 302, headers: {
        location: "https://app.oauth.test/app", "set-cookie": cookie,
      } });
      assert.equal((await metrics(t, `/api/auth/callback/${provider}`, response))
        .some(({ routeGroup }) => routeGroup === "session_created"), false);
    }
  }
});

integration("GitHub private verified email signs in to one stable account; unverified matching email cannot link", async (t) => {
  const f = await fixture();
  let profile = { id: 1234, login: "github-person", name: "GitHub Person", email: null };
  let email = "private@example.test";
  let verified = true;
  const calls = [];
  const mock = t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "isolated-provider-token", token_type: "bearer", scope: "read:user user:email" });
    }
    if (url === "https://api.github.com/user") return Response.json(profile);
    if (url === "https://api.github.com/user/emails") return Response.json([{ email, primary: true, verified }]);
    throw new Error("Unexpected provider request");
  });
  const signIn = async () => {
    const started = await f.call("/sign-in/social", { body: { provider: "github",
      callbackURL: `${f.env.APP_URL}/app`, errorCallbackURL: `${f.env.APP_URL}/login` } });
    assert.equal(started.status, 200);
    const authorization = new URL((await started.json()).url);
    assert.equal(authorization.origin, "https://github.com");
    assert.equal(authorization.searchParams.get("redirect_uri"), `${f.env.HUB_URL}/api/auth/callback/github`);
    assert.equal(authorization.searchParams.get("scope"), "read:user user:email");
    const cookie = started.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    return f.call(`/callback/github?state=${authorization.searchParams.get("state")}&code=isolated-code`, { cookie });
  };
  try {
    const created = await signIn();
    assert.equal(created.headers.get("location"), `${f.env.APP_URL}/app`);
    assert.ok(created.headers.getSetCookie().some(value => value.includes(".session_token=")));
    const users = await f.run("SELECT id,email,email_verified,handle FROM control.auth_users");
    assert.equal(users.length, 1);
    assert.equal(users[0].email, email);
    assert.equal(users[0].email_verified, true);
    assert.ok(users[0].handle);
    const id = users[0].id;
    // A returning linked identity keeps its local account even if GitHub's
    // primary address changes; it must not create another Human.
    email = "changed@example.test";
    assert.equal((await signIn()).headers.get("location"), `${f.env.APP_URL}/app`);
    assert.deepEqual(await f.run("SELECT id,email FROM control.auth_users"), [{ id, email: "private@example.test" }]);
    assert.deepEqual(await f.run("SELECT provider_id,account_id,user_id FROM control.auth_accounts"),
      [{ provider_id: "github", account_id: "1234", user_id: id }]);
    // Another GitHub account cannot take the existing Human by presenting an
    // unverified address, and refusal must create neither account nor session.
    profile = { ...profile, id: 5678 };
    email = "private@example.test";
    verified = false;
    const sessions = (await f.run("SELECT count(*)::int n FROM control.auth_sessions"))[0].n;
    const refused = await signIn();
    assert.ok(new URL(refused.headers.get("location")).searchParams.has("error"));
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions"))[0].n, sessions);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_accounts"))[0].n, 1);
    verified = true;
    assert.equal((await signIn()).headers.get("location"), `${f.env.APP_URL}/app`);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_users"))[0].n, 1);
    assert.deepEqual(await f.run("SELECT user_id FROM control.auth_accounts WHERE account_id='5678'"), [{ user_id: id }]);
    assert.equal(calls.filter(url => url.endsWith("/user/emails")).length, 4);
  } finally { mock.mock.restore(); await f.close(); }
});
