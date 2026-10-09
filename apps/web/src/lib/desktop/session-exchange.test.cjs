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
  assert.deepEqual(await requestCliSessionExchange("browser-token"), session);
  await assert.rejects(exchangeDesktopCliSession("browser-token"), /The local daemon session was missing from the response/);

  response = new Response(JSON.stringify({ ...session, refreshToken: "refresh-token", extra: "ignored" }));
  assert.deepEqual(await exchangeDesktopCliSession("browser-token"), { ...session, refreshToken: "refresh-token" });
  for (const request of requests) {
    assert.equal(request.url, WEB_PROXY_ROUTES.cli_exchange_session);
    assert.deepEqual(request.init, { cache: "no-store", method: "POST", headers: { authorization: "Bearer browser-token" } });
  }
  response = new Response(JSON.stringify({ error: "exchange denied", code: "forbidden" }), { status: 403 });
  await assert.rejects(exchangeDesktopCliSession("browser-token"), { status: 403, code: "forbidden", message: "exchange denied" });
  response = new Response("invalid JSON", { status: 500 });
  await assert.rejects(exchangeDesktopCliSession("browser-token"), { status: 500, message: "Request failed (500)" });
});
