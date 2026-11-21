const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { frameWindow } = require("../lib/extension-embed-test-frame.cjs");

// The page's hop to the Hub, in the Worker's place: every call goes to the
// Hub and nowhere else, as the extension's client, under the caller's bearer
// or, when the call carries none, the extension's own current token.
const EXTENSION = "chrome-extension://kaickfjmldmlelnfijaahialjpnebnak";
const HUB = "https://xmatrix-hub.xmatrix.sh";

function install(t, { token = "panel-token" } = {}) {
  const asked = [];
  const win = frameWindow(EXTENSION);
  // The panel page: answers a session request with its token, or as signed out.
  win.parent.postMessage = (message, origin) => {
    assert.equal(origin, EXTENSION);
    asked.push(message.type);
    queueMicrotask(() => win.dispatch({ source: win.parent, origin: EXTENSION,
      data: { protocol: "xmatrix-embed/1", id: message.id, ...(token ? { type: "session", token } : { type: "signed-out" }) } }));
  };
  const sent = [];
  const nativeFetch = globalThis.fetch;
  globalThis.window = win;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body });
    return Response.json({ ok: true });
  };
  t.after(() => { delete globalThis.window; globalThis.fetch = nativeFetch; });
  return { sent, asked, proxy: require("./hub-proxy.ts") };
}

test("a call carries the caller's bearer to the Hub, as the extension's client", async (t) => {
  const { sent, asked, proxy } = install(t);
  await proxy.proxyXMatrixRequest({ route: "/api/spaces?x=1", method: "GET", authorization: "Bearer callers-own" });
  assert.equal(sent[0].url, `${HUB}/api/spaces?x=1`);
  assert.equal(sent[0].headers.authorization, "Bearer callers-own");
  assert.equal(sent[0].headers["x-xmatrix-client-component"], "app");
  assert.equal(sent[0].headers["x-xmatrix-client-platform"], "chrome-extension");
  assert.deepEqual(asked, []);
});

test("a call without a bearer gets the extension's current token", async (t) => {
  const { sent, asked, proxy } = install(t);
  await proxy.proxyXMatrixRequest({ route: "/api/push/config", method: "GET" });
  assert.equal(sent[0].headers.authorization, "Bearer panel-token");
  assert.deepEqual(asked, ["session-request"]);
});

test("a signed-out extension leaves a bearerless call without one", async (t) => {
  const { sent, proxy } = install(t, { token: null });
  await proxy.proxyXMatrixRequest({ route: "/api/push/config", method: "GET" });
  assert.equal(sent[0].headers.authorization, undefined);
});

test("a route handler forwards the Hub route its params name, with the request's body", async (t) => {
  const { sent, proxy } = install(t);
  const handler = proxy.hubRouteHandler("POST", (channelId) => `/api/channels/${channelId}/messages`, ["channelId"]);
  const abort = new AbortController();
  const request = new Request(`${EXTENSION}/api/xmatrix/channels/c1/messages`, { method: "POST",
    headers: { authorization: "Bearer callers-own" }, body: JSON.stringify({ body: "hi" }), signal: abort.signal });
  const response = await handler(request, { params: Promise.resolve({ channelId: "c1" }) });
  assert.equal(response.status, 200);
  assert.equal(sent[0].url, `${HUB}/api/channels/c1/messages`);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].body, JSON.stringify({ body: "hi" }));
  assert.equal(sent[0].headers["content-type"], "application/json");
});
