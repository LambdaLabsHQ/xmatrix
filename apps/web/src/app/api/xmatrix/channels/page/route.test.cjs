const assert = require("node:assert/strict");
const test = require("node:test");
const { HUB_ROUTES } = require("@xmatrix/protocol");
const { loadProxyRouteGet } = require("../../proxy-route-test-fixture.cjs");

const loadRoute = (proxy) => loadProxyRouteGet(__dirname, proxy);

for (const flag of ["includeCounts=false", "countsOnly=true"]) {
  test(`catalog proxy preserves ${flag} so Hub can skip unnecessary work`, async () => {
    let forwarded;
    const response = new Response("{}", { status: 200 });
    const get = loadRoute(input => { forwarded = input; return response; });
    assert.equal(await get(new Request(`https://web.test/api/xmatrix/channels/page?spaceId=space-1&view=tree&${flag}`, {
      headers: { authorization: "Bearer test-token" },
    })), response);
    const url = new URL(forwarded.route, "https://hub.test");
    assert.equal(url.pathname, HUB_ROUTES.channel_catalog_page);
    const [name, value] = flag.split("=");
    assert.equal(url.searchParams.get(name), value);
    assert.equal(url.searchParams.get("spaceId"), "space-1");
    assert.equal(forwarded.method, "GET");
    assert.equal(forwarded.authorization, "Bearer test-token");
  });
}

test("catalog proxy keeps default behavior, pagination, and the query allowlist", async () => {
  let forwarded;
  const get = loadRoute(input => { forwarded = input; return new Response("{}"); });
  const params = new URLSearchParams({ spaceId: "space-1", view: "search", filter: "unread",
    scopeChannelId: "parent-1", query: "a & b", cursor: "opaque+cursor", principalId: "other-user" });
  await get(new Request(`https://web.test/api/xmatrix/channels/page?${params}`));
  const url = new URL(forwarded.route, "https://hub.test");
  params.delete("principalId");
  assert.equal(url.searchParams.toString(), params.toString());
  assert.equal(forwarded.authorization, undefined);
});

test("catalog optimization flags do not bypass proxy authorization failures", async () => {
  const denied = new Response("Forbidden", { status: 403 });
  const get = loadRoute(() => denied);
  assert.equal(await get(new Request("https://web.test/api/xmatrix/channels/page?spaceId=private&countsOnly=true")), denied);
});
