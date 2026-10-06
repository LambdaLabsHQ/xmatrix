const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { requestAuthorizationNeedsRefresh, resolveProxyAuthorization } = require("./xmatrix-proxy-auth.ts");

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

test("resolveProxyAuthorization prefers explicit request authorization", () => {
  assert.equal(
    resolveProxyAuthorization({
      requestAuthorization: "Bearer client-token",
      cookieAuthorization: "Bearer cookie-token",
    }),
    "Bearer client-token"
  );
});

test("resolveProxyAuthorization falls back to cookie authorization", () => {
  assert.equal(
    resolveProxyAuthorization({
      cookieAuthorization: "Bearer cookie-token",
    }),
    "Bearer cookie-token"
  );
});

test("resolveProxyAuthorization ignores blank authorization values", () => {
  assert.equal(
    resolveProxyAuthorization({
      requestAuthorization: "  ",
      cookieAuthorization: "  ",
    }),
    undefined
  );
});

test("resolveProxyAuthorization replaces an expiring request JWT only for the same subject", () => {
  const expiring = `Bearer ${jwt({ sub: "user:1", exp: 1_100 })}`;
  const renewed = `Bearer ${jwt({ sub: "user:1", exp: 10_000 })}`;

  assert.equal(
    resolveProxyAuthorization({
      requestAuthorization: expiring,
      cookieAuthorization: renewed,
      nowSeconds: 1_000,
    }),
    renewed
  );
});

test("resolveProxyAuthorization never changes principals while renewing", () => {
  const expiring = `Bearer ${jwt({ sub: "user:1", exp: 1_100 })}`;
  const otherUser = `Bearer ${jwt({ sub: "user:2", exp: 10_000 })}`;

  assert.equal(
    resolveProxyAuthorization({
      requestAuthorization: expiring,
      cookieAuthorization: otherUser,
      nowSeconds: 1_000,
    }),
    expiring
  );
});

test("requestAuthorizationNeedsRefresh detects the suspended-tab expiry window", () => {
  const token = `Bearer ${jwt({ sub: "user:1", exp: 1_200 })}`;

  assert.equal(requestAuthorizationNeedsRefresh(token, 1_000), true);
  assert.equal(requestAuthorizationNeedsRefresh(token, 800), false);
  assert.equal(requestAuthorizationNeedsRefresh("Bearer opaque", 1_000), false);
});
