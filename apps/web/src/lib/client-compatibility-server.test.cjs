const assert = require("node:assert/strict");
const { test } = require("node:test");

async function loadModule() {
  return import("./client-compatibility-server.ts");
}

async function loadHubUrlModule() {
  return import("./xmatrix.ts");
}

test("the app admission cookie round-trips only a currently compatible app", async () => {
  const compatibility = await loadModule();
  const identity = {
    component: "app",
    version: "0.16.160",
    protocolVersion: 2,
    platform: "macos",
  };
  const cookie = compatibility.serializeAppCompatibilityCookie(identity);
  assert.deepEqual(compatibility.parseAppCompatibilityCookie(cookie), identity);
  assert.equal(
    compatibility.parseAppCompatibilityCookie("app|0.16.159|2|macos"),
    undefined,
  );
  assert.equal(
    compatibility.parseAppCompatibilityCookie("cli|0.16.160|2|macos"),
    undefined,
  );
});

test("only update and authentication proxy routes bypass app admission", async () => {
  const compatibility = await loadModule();
  assert.equal(compatibility.appCompatibilityRequiredForProxyRoute("/api/channels"), true);
  assert.equal(compatibility.appCompatibilityRequiredForProxyRoute("/api/relay-v2/runtime/session"), true);
  assert.equal(compatibility.appCompatibilityRequiredForProxyRoute("/api/auth/me"), false);
  assert.equal(compatibility.appCompatibilityRequiredForProxyRoute("/api/space-invites/token"), false);
});

test("the Web proxy uses the browser-visible Hub origin, never a private worker override", async () => {
  const xmatrix = await loadHubUrlModule();
  assert.equal(
    xmatrix.getXMatrixHubUrl({
      NEXT_PUBLIC_XMATRIX_HUB_URL: "https://current-hub.example/",
      XMATRIX_HUB_URL: "https://stale-hub.example/",
    }),
    "https://current-hub.example",
  );
  assert.equal(
    xmatrix.getXMatrixHubUrl({ XMATRIX_HUB_URL: "https://stale-hub.example/" }),
    "https://xmatrix-hub.xmatrix.sh",
  );
});
