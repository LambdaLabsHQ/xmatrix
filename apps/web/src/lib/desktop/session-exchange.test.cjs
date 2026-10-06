const assert = require("node:assert/strict");
const test = require("node:test");
require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { exchangeDesktopCliSession, requestCliSessionExchange } = require("./session-exchange.ts");
const { WEB_PROXY_ROUTES } = require("@xmatrix/protocol");

test("session exchange keeps native validation separate from the legacy callback transport", async (t) => {
  const session = {
    token: "cli-token",
    user: { id: "user-1" },
    hubUrl: "https://hub.example.test",
    relayUrl: "https://relay.example.test",
  };
  let response = new Response(JSON.stringify(session));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return response.clone();
  });
  const legacy = await requestCliSessionExchange("browser-token");
  assert.equal(legacy.exchangeResponse.ok, true);
  assert.deepEqual(legacy.cliSession, session);
  await assert.rejects(exchangeDesktopCliSession("browser-token"), /Local daemon session exchange response was incomplete/);

  response = new Response(JSON.stringify({ ...session, refreshToken: "refresh-token", extra: "ignored" }));
  assert.deepEqual(await exchangeDesktopCliSession("browser-token"), { ...session, refreshToken: "refresh-token" });
  for (const request of requests) {
    assert.equal(request.url, WEB_PROXY_ROUTES.cli_exchange_session);
    assert.deepEqual(request.init, { method: "POST", headers: { authorization: "Bearer browser-token" } });
  }
  response = new Response(JSON.stringify({ error: "exchange denied" }), { status: 403 });
  await assert.rejects(exchangeDesktopCliSession("browser-token"), /exchange denied/);
  response = new Response("invalid JSON", { status: 500 });
  await assert.rejects(exchangeDesktopCliSession("browser-token"), /Failed to create a local daemon session/);
});
