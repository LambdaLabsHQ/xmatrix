import assert from "node:assert/strict";
import { test } from "node:test";

import { ensureMcpEdgePolicy, verifyMcpEdgeAccess } from "./mcp-edge-policy.mjs";

// The owning edge boundary: a broad skip, wrong account or ruleset replacement
// bypasses unrelated protections before any Hub MCP test can observe it.
const account = "a".repeat(32), zone = "b".repeat(32), ruleset = "c".repeat(32), ruleId = "d".repeat(32);
const options = { accountId: account, token: "private-token", hubOrigin: "https://hub.example.com", appOrigin: "https://example.com" };
const expected = {
  ref: "xmatrix_mcp_bic_compatibility",
  expression: '(http.host eq "hub.example.com" and http.request.uri.path eq "/mcp")',
  action: "skip", action_parameters: { products: ["bic"] }, enabled: true, logging: { enabled: true },
};
const owned = () => ({ ...structuredClone(expected), id: ruleId });
const entrypoint = rules => ({ id: ruleset, kind: "zone", phase: "http_request_firewall_custom", rules });
const zones = () => [{ hostname: "hub.example.com", zone_name: "example.com", zone_id: zone }];

function cloudflare({ existing = null, zoneRows = zones(), lostReply = false } = {}) {
  const calls = [];
  let current = existing;
  return { calls, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body });
    assert.equal(init.headers.Authorization, "Bearer private-token");
    if (path.endsWith("/domains")) {
      assert.equal(path, `/client/v4/accounts/${account}/workers/domains`);
      assert.equal(new URL(url).searchParams.get("hostname"), "hub.example.com");
      return Response.json({ success: true, result: zoneRows });
    }
    if (init.method === "GET") return current ? Response.json({ success: true, result: current })
      : Response.json({ success: false }, { status: 404 });
    if (path.endsWith("/rules")) current = entrypoint([...current.rules, { ...body, id: ruleId }]);
    else current = { ...body, id: ruleset, rules: body.rules.map(rule => ({ ...rule, id: ruleId })) };
    if (lostReply) throw new Error("lost after commit");
    return Response.json({ success: true, result: current });
  } };
}

test("existing rules gain only an exact-host /mcp BIC rule; a retry never writes again", async () => {
  const cf = cloudflare({ existing: entrypoint([{ action: "block", expression: "cf.client.bot eq false" }]) });
  await ensureMcpEdgePolicy({ ...options, fetchImpl: cf.fetchImpl });
  await ensureMcpEdgePolicy({ ...options, fetchImpl: cf.fetchImpl });
  const writes = cf.calls.filter(call => call.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, `/client/v4/zones/${zone}/rulesets/${ruleset}/rules`);
  const { description: _description, ...rule } = writes[0].body;
  assert.deepEqual(rule, expected);
});

test("an absent entrypoint is created once; a lost response settles by readback", async () => {
  const cf = cloudflare({ lostReply: true });
  const result = await ensureMcpEdgePolicy({ ...options, fetchImpl: cf.fetchImpl });
  assert.equal(result.ruleId, ruleId);
  assert.equal(cf.calls.filter(call => call.method === "POST").length, 1);
  const create = cf.calls.find(call => call.method === "POST");
  assert.equal(create.path, `/client/v4/zones/${zone}/rulesets`);
  assert.equal(create.body.kind, "zone");
  assert.equal(create.body.rules.length, 1);
});

test("ambiguous or foreign zones and cross-zone origins fail before a write", async () => {
  for (const zoneRows of [[], [...zones(), ...zones()], [{ ...zones()[0], zone_name: "foreign.test" }]]) {
    const cf = cloudflare({ zoneRows });
    await assert.rejects(ensureMcpEdgePolicy({ ...options, fetchImpl: cf.fetchImpl }), /deployment-owned zone/u);
    assert.equal(cf.calls.some(call => call.method !== "GET"), false);
  }
  const cf = cloudflare();
  await assert.rejects(ensureMcpEdgePolicy({ ...options, hubOrigin: "https://hub.example.com.evil.test", fetchImpl: cf.fetchImpl }), /production Web zone/u);
  assert.equal(cf.calls.length, 0);
});

test("drift never broadens a skip or overwrites administrator configuration", async () => {
  for (const changed of [
    { ...owned(), expression: "true" },
    { ...owned(), action_parameters: { products: ["bic"], phases: ["http_ratelimit"] } },
    { ...owned(), enabled: false },
  ]) {
    const cf = cloudflare({ existing: entrypoint([changed]) });
    await assert.rejects(ensureMcpEdgePolicy({ ...options, fetchImpl: cf.fetchImpl }), /refusing to overwrite/u);
    assert.equal(cf.calls.some(call => call.method !== "GET"), false);
  }
});

test("permission refusals fail closed without relaying provider data or credentials", async () => {
  await assert.rejects(ensureMcpEdgePolicy({ ...options, fetchImpl: async () => Response.json({
    success: false, errors: [{ message: "private-token private-provider-context" }],
  }, { status: 403 }) }), error => {
    assert.match(error.message, /HTTP 403/u);
    assert.doesNotMatch(error.message, /private-/u);
    return true;
  });
});

test("an anonymous Python client must receive the exact Hub OAuth challenge", async () => {
  await verifyMcpEdgeAccess(options.hubOrigin, { fetchImpl: async (url, init) => {
    assert.equal(String(url), "https://hub.example.com/mcp");
    assert.equal(init.headers["User-Agent"], "Python-urllib/3.12");
    assert.equal("Authorization" in init.headers, false);
    return new Response(null, { status: 401, headers: {
      "WWW-Authenticate": 'Bearer resource_metadata="https://hub.example.com/.well-known/oauth-protected-resource/mcp"',
    } });
  } });
  for (const status of [200, 403, 401]) {
    await assert.rejects(verifyMcpEdgeAccess(options.hubOrigin, {
      attempts: 1, fetchImpl: async () => new Response(null, { status }),
    }), /OAuth challenge/u);
  }
});
