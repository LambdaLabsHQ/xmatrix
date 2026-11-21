import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { bingRelay, serve } from "../../../deploy/bing-relay/server.mjs";

const token = "relay_token_0123456789abcdef0123456789";
const tokenSha256 = createHash("sha256").update(token).digest("hex");
const apiKey = "0123456789abcdef0123456789abcdef";
const method = "https://relay.test/webmaster/api.svc/json/GetUserSites?siteUrl=https%3A%2F%2Fexample.com%2F";

function relay(reply = () => Response.json({ d: [] })) {
  const calls = [];
  const handler = bingRelay({ tokenSha256, fetch: async (url, init) => { calls.push({ url: String(url), init }); return reply(); } });
  return { handler, calls };
}
const authorized = (extra = {}) => ({ authorization: `Bearer ${token}`, "x-bing-apikey": apiKey, ...extra });

test("an authorized Bing method is forwarded to ssl.bing.com with the key added there", async () => {
  const { handler, calls } = relay(() => Response.json({ d: [{ Url: "https://example.com/" }] }, { status: 200 }));
  const response = await handler(new Request(method, { headers: authorized() }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { d: [{ Url: "https://example.com/" }] });
  const forwarded = new URL(calls[0].url);
  assert.equal(forwarded.origin + forwarded.pathname, "https://ssl.bing.com/webmaster/api.svc/json/GetUserSites");
  assert.equal(forwarded.searchParams.get("apikey"), apiKey);
  assert.equal(forwarded.searchParams.get("siteUrl"), "https://example.com/");
  assert.equal(calls[0].init.redirect, "manual");

  const posted = relay(() => Response.json({ ErrorCode: 17, Message: "ERROR!!! ThrottleIP" }, { status: 400 }));
  const body = JSON.stringify({ siteUrl: "https://example.com/", urlList: ["https://example.com/a"] });
  const answer = await posted.handler(new Request(method.replace("GetUserSites", "SubmitUrlBatch"), { method: "POST", body,
    headers: authorized({ "content-type": "application/json" }) }));
  assert.equal(answer.status, 400, "Bing's own status and error pass through");
  assert.equal((await answer.json()).ErrorCode, 17);
  assert.equal(new TextDecoder().decode(posted.calls[0].init.body), body);
});

test("anything but an authorized Bing Webmaster JSON method is refused without an outbound call", async () => {
  const { handler, calls } = relay();
  const refusals = [
    [new Request(method, { headers: { "x-bing-apikey": apiKey } }), 401],
    [new Request(method, { headers: authorized({ authorization: `Bearer ${token}x` }) }), 401],
    [new Request(method, { headers: authorized({ authorization: token }) }), 401],
    [new Request("https://relay.test/webmaster/api.svc/json/../../other", { headers: authorized() }), 404],
    [new Request("https://relay.test/other/GetUserSites", { headers: authorized() }), 404],
    [new Request(method, { method: "DELETE", headers: authorized() }), 404],
    [new Request(method, { headers: authorized({ "x-bing-apikey": "" }) }), 400],
    [new Request(method, { headers: authorized({ "x-bing-apikey": "bad key" }) }), 400],
    [new Request(`${method}&apikey=${apiKey}`, { headers: authorized() }), 400],
  ];
  for (const [request, status] of refusals) {
    const response = await handler(request);
    assert.equal(response.status, status, request.url);
    assert.match((await response.json()).Message, /^relay: /u);
  }
  assert.equal(calls.length, 0);
  assert.equal((await handler(new Request("https://relay.test/health"))).status, 200);
  assert.throws(() => bingRelay({ tokenSha256: "" }), /BING_RELAY_TOKEN_SHA256/u);
});

test("the node:http server bounds the request body and serves the handler", async () => {
  const { handler } = relay();
  const server = serve(handler, 0);
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/webmaster/api.svc/json/GetUserSites`, { headers: authorized() })).status, 200);
    const large = await fetch(`${base}/webmaster/api.svc/json/SubmitUrlBatch`, { method: "POST", headers: authorized(),
      body: "x".repeat(1024 * 1024 + 1) }).then(response => response.status, () => 413);
    assert.equal(large, 413);
  } finally {
    server.close();
  }
});
