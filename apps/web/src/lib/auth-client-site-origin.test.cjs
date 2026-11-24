const assert = require("node:assert/strict");
const test = require("node:test");

// A build whose site has an origin of its own beside the app's, as the production Webs have (`web.siteOrigin` and
// `web.beta.siteOrigin` in the deploy profile). site-url.ts reads both origins when it loads.
process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
process.env.NEXT_PUBLIC_SITE_URL = "https://site.example";
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { loadBetterAuthSession } = require("./auth-client.ts");

/** The Hub as it answers a signed-in browser at the app's origin; returns the paths it was asked for. */
function hub(t) {
  const asked = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    asked.push(new URL(typeof input === "string" ? input : input.url).pathname);
    return Response.json({ user: { id: "user-1", email: "alice@example.com" }, session: { token: "session" } },
      { headers: { "set-auth-jwt": "jwt" } });
  });
  return asked;
}

/** Opens the page at `origin` for the rest of the test. */
function openAt(t, origin) {
  globalThis.window = { location: new URL(origin) };
  t.after(() => { delete globalThis.window; });
}

test("a page at the site's own origin is signed out without asking the Hub, which does not answer it there", async (t) => {
  const asked = hub(t);
  openAt(t, "https://site.example");
  assert.deepEqual(await loadBetterAuthSession(), { session: null, user: null });
  assert.deepEqual(asked, []);
});

test("the same build at the app's origin still reads its session from the Hub", async (t) => {
  const asked = hub(t);
  openAt(t, "https://app.example");
  const { user, session } = await loadBetterAuthSession();
  assert.equal(user.email, "alice@example.com");
  assert.equal(session.access_token, "jwt");
  assert.deepEqual(asked, ["/api/auth/get-session"]);
});
