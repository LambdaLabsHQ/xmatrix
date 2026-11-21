const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

// The app packaged in the Chrome extension answers the Web's `/api` in the
// page. A request must reach the route Next would give it, with the params
// Next would give that route, or the page asks the Hub for the wrong thing.
const { createLocalApi } = require("./local-api.ts");

const answer = (name) => ({
  GET: async (_request, context) => Response.json({ route: name, params: await context.params }),
});
const ROUTES = [
  ["xmatrix/spaces/[spaceId]/pages/[[...path]]", answer("pages")],
  ["xmatrix/channels/[channelId]", answer("channel")],
  ["xmatrix/channels/page", answer("catalog page")],
  ["xmatrix/channels/[channelId]/messages/[messageId]", { ...answer("message"), DELETE: async () => new Response(null, { status: 204 }) }],
  ["xmatrix/native-auth/[...path]", answer("rest")],
];

function api(hubFetch = async () => { throw new Error("the Hub was not expected"); }) {
  const local = createLocalApi(ROUTES, hubFetch);
  return (path, init) => local(new Request(`https://page.test${path}`, init));
}

test("a request reaches the route Next would match, a fixed name before a parameter", async () => {
  const call = api();
  assert.deepEqual(await (await call("/api/xmatrix/channels/page?spaceId=s")).json(), { route: "catalog page", params: {} });
  assert.deepEqual(await (await call("/api/xmatrix/channels/c%201")).json(), { route: "channel", params: { channelId: "c 1" } });
  assert.deepEqual(await (await call("/api/xmatrix/channels/c1/messages/m1")).json(),
    { route: "message", params: { channelId: "c1", messageId: "m1" } });
});

test("a catch-all takes the rest of the path, and an optional one takes none", async () => {
  const call = api();
  assert.deepEqual(await (await call("/api/xmatrix/spaces/s1/pages")).json(), { route: "pages", params: { spaceId: "s1" } });
  assert.deepEqual(await (await call("/api/xmatrix/spaces/s1/pages/p1/history")).json(),
    { route: "pages", params: { spaceId: "s1", path: ["p1", "history"] } });
  assert.equal((await call("/api/xmatrix/native-auth")).status, 404);
  assert.deepEqual(await (await call("/api/xmatrix/native-auth/a/b")).json(), { route: "rest", params: { path: ["a", "b"] } });
});

test("a path with no route, or a method its route does not serve, is refused in the page", async () => {
  const call = api();
  assert.equal((await call("/api/xmatrix/login")).status, 404);
  assert.equal((await call("/api/xmatrix/channels/c1/extra")).status, 404);
  assert.equal((await call("/api/xmatrix/channels/c1", { method: "POST", body: "{}" })).status, 405);
  assert.equal((await call("/api/xmatrix/channels/c1/messages/m1", { method: "DELETE" })).status, 204);
});

test("the client compatibility check asks the Hub under the identity the page names", async () => {
  const { CLIENT_COMPATIBILITY_PATH, CLIENT_COMPATIBILITY_POLICY } = require("@xmatrix/protocol");
  const seen = [];
  const call = api(async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return Response.json({ compatible: true });
  });
  const identity = { component: "app", version: "9.9.9", protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion, platform: "chrome-extension" };
  const response = await call("/api/client-compatibility", { method: "POST", body: JSON.stringify(identity) });
  assert.deepEqual(await response.json(), { compatible: true });
  assert.equal(new URL(seen[0].url).pathname, CLIENT_COMPATIBILITY_PATH);
  assert.equal(seen[0].headers["x-xmatrix-client-platform"], "chrome-extension");
  assert.equal(seen[0].headers["x-xmatrix-client-version"], "9.9.9");
  // Not an identity: refused here, the Hub is not asked.
  assert.equal((await call("/api/client-compatibility", { method: "POST", body: "{}" })).status, 426);
  assert.equal(seen.length, 1);
});
