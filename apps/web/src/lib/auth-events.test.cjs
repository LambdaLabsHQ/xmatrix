const assert = require("node:assert/strict");
const test = require("node:test");

require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

test("a 401 to a request that sent the token renews it; other refusals do not", async (t) => {
  const events = [];
  const win = new EventTarget();
  win.addEventListener("xmatrix:auth-token-rejected", () => events.push("renew"));
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });
  const { xmatrixRawResponse, xmatrixApiRequest } = require("./query/api-client.ts");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let status = 401;
  globalThis.fetch = async () => new Response("{}", { status });

  await xmatrixRawResponse("/api/x", { headers: { Authorization: "Bearer stale" } });
  assert.deepEqual(events, ["renew"]);
  await xmatrixRawResponse("/api/session");
  assert.deepEqual(events, ["renew"], "a cookie session read is not a stale bearer token");
  await assert.rejects(xmatrixApiRequest({ url: "/api/x", token: "stale" }));
  assert.deepEqual(events, ["renew", "renew"]);
  status = 403;
  await xmatrixRawResponse("/api/x", { headers: { Authorization: "Bearer fine" } });
  assert.deepEqual(events, ["renew", "renew"], "a refusal is not a stale token");
});
