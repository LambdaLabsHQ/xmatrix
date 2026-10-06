const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  jwtExpiresAtSeconds,
  isTransientAuthStatus,
  shouldRefreshAuthSessionState,
  isTransientNetworkSessionError,
  shouldApplySessionRead,
} = require("./auth-session-policy.ts");

test("auth status policy separates credential rejection from temporary failures", () => {
  assert.equal(isTransientAuthStatus(400), false);
  assert.equal(isTransientAuthStatus(401), false);
  assert.equal(isTransientAuthStatus(403), false);
  assert.equal(isTransientAuthStatus(408), true);
  assert.equal(isTransientAuthStatus(429), true);
  assert.equal(isTransientAuthStatus(500), true);
  assert.equal(isTransientAuthStatus(503), true);
  assert.equal(isTransientAuthStatus(undefined), false);
});

function jwtWithExp(exp) {
  const payload = Buffer.from(JSON.stringify({ exp }), "utf8")
    .toString("base64url");
  return `header.${payload}.signature`;
}

test("jwtExpiresAtSeconds reads JWT exp without verifying the token", () => {
  assert.equal(jwtExpiresAtSeconds(jwtWithExp(1234)), 1234);
});

test("fresh authenticated sessions do not refresh on every focus", () => {
  assert.equal(
    shouldRefreshAuthSessionState(
      {
        loading: false,
        user: { id: "user-1" },
        session: { access_token: jwtWithExp(10_000) },
      },
      1_000
    ),
    false
  );
});

test("sessions refresh when the token is missing or close to expiry", () => {
  assert.equal(
    shouldRefreshAuthSessionState({
      loading: false,
      user: { id: "user-1" },
      session: { access_token: "" },
    }),
    true
  );
  assert.equal(
    shouldRefreshAuthSessionState(
      {
        loading: false,
        user: { id: "user-1" },
        session: { access_token: jwtWithExp(1_200) },
      },
      1_000
    ),
    true
  );
});

test("Failed to fetch and sibling network errors are not logout", () => {
  assert.equal(isTransientNetworkSessionError(new TypeError("Failed to fetch")), true);
  assert.equal(isTransientNetworkSessionError(new TypeError("Load failed")), true);
  assert.equal(
    isTransientNetworkSessionError(new TypeError("NetworkError when attempting to fetch resource")),
    true
  );
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  assert.equal(isTransientNetworkSessionError(abort), true);
  assert.equal(isTransientNetworkSessionError(new Error("Failed to load native app session")), false);
});

test("a live session is not replaced by an empty later read", () => {
  assert.equal(
    shouldApplySessionRead({ currentSession: { access_token: "live" }, nextSession: null }),
    false
  );
  assert.equal(
    shouldApplySessionRead({
      currentSession: { access_token: "live" },
      nextSession: { access_token: "fresh" },
    }),
    true
  );
  assert.equal(
    shouldApplySessionRead({ currentSession: null, nextSession: null }),
    true
  );
});

test("sessions without a JWT exp use the session expiry fallback", () => {
  assert.equal(
    shouldRefreshAuthSessionState(
      {
        loading: false,
        user: { id: "user-1" },
        session: { access_token: "opaque-token", expires_at: 10_000 },
      },
      1_000
    ),
    false
  );
  assert.equal(
    shouldRefreshAuthSessionState(
      {
        loading: false,
        user: { id: "user-1" },
        session: { access_token: "opaque-token", expires_at: 1_200 },
      },
      1_000
    ),
    true
  );
});
