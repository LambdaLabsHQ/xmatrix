const assert = require("node:assert/strict");
const test = require("node:test");

let services;

test.before(async () => {
  services = await import("./sign-in-services.ts");
});

test("the App Store Connect window shows Apple's pages over HTTPS and nothing else", () => {
  const service = services.SIGN_IN_SERVICES.appstoreconnect;
  for (const url of ["https://appstoreconnect.apple.com/login", "https://idmsa.apple.com/appleauth/auth/signin", "https://apple.com/legal"]) {
    assert.equal(services.allowedInSignIn(service, url), true, url);
  }
  for (const url of ["http://appstoreconnect.apple.com/", "https://apple.com.example.com/", "https://evilapple.com/",
    "https://user:pass@appstoreconnect.apple.com/", "javascript:alert(1)", "not a url"]) {
    assert.equal(services.allowedInSignIn(service, url), false, url);
  }
});

test("the session counts only once Apple's website names a user and a team", () => {
  const { accepts } = services.SIGN_IN_SERVICES.appstoreconnect.probe;
  assert.equal(accepts(200, { user: { fullName: "A" }, provider: { name: "Team" } }), true);
  assert.equal(accepts(200, { user: { fullName: "A" } }), false);
  assert.equal(accepts(401, { user: {}, provider: {} }), false);
  assert.equal(accepts(200, null), false);
});

test("the handed-over session is the Cookie header a browser would send, without values it could not carry", () => {
  assert.equal(services.sessionCookieHeader([{ name: "myacinfo", value: "abc" }, { name: "dqsid", value: "x=y" },
    { name: "bad name", value: "1" }, { name: "empty", value: "" }, { name: "spaced", value: "a b" }]), "myacinfo=abc; dqsid=x=y");
  assert.equal(services.signInServiceId("appstoreconnect"), "appstoreconnect");
  assert.equal(services.signInServiceId("toString"), null);
  assert.equal(services.signInServiceId(1), null);
});
