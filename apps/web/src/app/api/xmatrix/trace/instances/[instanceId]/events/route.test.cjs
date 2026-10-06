const assert = require("node:assert/strict");
const test = require("node:test");
const { HUB_ROUTES } = require("@xmatrix/protocol");
const { loadProxyRouteGet } = require("../../../../proxy-route-test-fixture.cjs");

const loadRoute = (proxy) => loadProxyRouteGet(__dirname, proxy);

test("trace proxy forwards the older-page cursor and drops unknown parameters", async () => {
  let forwarded;
  const get = loadRoute((input) => { forwarded = input; return new Response("{}"); });
  const params = new URLSearchParams({
    limit: "500", since: "2026-07-01T00:00:14.000Z", before: "2026-07-01T00:00:10.000Z|trace-10",
    waitMs: "25000",
    principalId: "other-user",
  });
  await get(new Request(`https://web.test/api/xmatrix/trace/instances/instance-1/events?${params}`, {
    headers: { authorization: "Bearer test-token" },
  }), { params: Promise.resolve({ instanceId: "instance-1" }) });
  const url = new URL(forwarded.route, "https://hub.test");
  assert.equal(url.pathname, HUB_ROUTES.trace_instance_events("instance-1"));
  params.delete("principalId");
  assert.equal(url.searchParams.toString(), params.toString());
  assert.equal(forwarded.method, "GET");
  assert.equal(forwarded.authorization, "Bearer test-token");
});
