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

integration("missing OAuth verification returns to login without creating a session or recording success", async (t) => {
  const f = await fixture();
  try {
    const response = await f.call("/callback/google?state=unknown-fixture-state&code=private-fixture-code");
    const logged = await metrics(t, "/api/auth/callback/google", response);
    assert.equal(logged[0].outcome, "error");
    assert.equal(logged.some(({ routeGroup }) => routeGroup === "session_created"), false);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${f.env.APP_URL}/login?error=state_mismatch`);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions"))[0].n, 0);
    assert.equal(JSON.stringify(logged).includes("private-fixture-code"), false);
  } finally { await f.close(); }
});

integration("a parsed OAuth state retains its validated error return, while a replay uses the login fallback", async (t) => {
  const f = await fixture();
  try {
    const started = await f.call("/sign-in/social", { body: {
      provider: "google", callbackURL: `${f.env.APP_URL}/app`,
      errorCallbackURL: `${f.env.APP_URL}/login?from=fixture`,
    } });
    assert.equal(started.status, 200);
    const state = new URL((await started.json()).url).searchParams.get("state");
    assert.ok(state);
    const cookie = started.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const path = `/callback/google?state=${state}&error=access_denied`;
    const denied = await f.call(path, { cookie });
    assert.equal(denied.headers.get("location"), `${f.env.APP_URL}/login?from=fixture&error=access_denied`);
    assert.equal((await metrics(t, "/api/auth/callback/google", denied))[0].outcome, "error");
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_verifications"))[0].n, 0);
    const replay = await f.call(path, { cookie });
    assert.equal(replay.headers.get("location"), `${f.env.APP_URL}/login?error=state_mismatch`);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions"))[0].n, 0);
  } finally { await f.close(); }
});

test("OAuth session metrics require a newly issued session cookie and never log redirect inputs", async (t) => {
  for (const prefix of ["better-auth", "__Secure-xmatrix-test"]) {
    const response = new Response(null, { status: 302, headers: {
      location: "https://app.oauth.test/app", "set-cookie": `${prefix}.session_token=private-session; Path=/; HttpOnly`,
    } });
    const logged = await metrics(t, "/api/auth/callback/google", response);
    assert.equal(logged.filter(({ routeGroup }) => routeGroup === "session_created").length, 1);
    assert.equal(JSON.stringify(logged).includes("private-session"), false);
  }
  for (const cookie of ["better-auth.state=; Max-Age=0", "better-auth.session_token=; Max-Age=0"]) {
    const response = new Response(null, { status: 302, headers: {
      location: "https://app.oauth.test/app", "set-cookie": cookie,
    } });
    assert.equal((await metrics(t, "/api/auth/callback/google", response))
      .some(({ routeGroup }) => routeGroup === "session_created"), false);
  }
});
