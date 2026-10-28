import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import * as protocol from "@xmatrix/protocol";
import * as connectors from "../src/app-connectors.ts";
import * as credentials from "../src/connectors/credentials.ts";
import * as shared from "../src/index-shared.ts";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

// The credential store keeps an OAuth grant bound only when an edit writes
// nothing but Hub-minted fields; the route is what tells it which those are,
// so regenerating an ingress key neither unbinds the grant nor launders its bot.
test("regenerating a Slack ingress key names it as Hub-generated to the credential store", async () => {
  const route = await compileCommonJsSourceModule(new URL("../src/index-routes-connectors.ts", import.meta.url));
  const puts = [];
  const repository = {
    readGenerated: async () => ({ ingressKey: "old-key" }),
    put: async (input) => { puts.push(input); return { credentialFields: ["botToken", "ingressKey"] }; },
  };
  const noop = () => {};
  const imports = {
    "@xmatrix/protocol": protocol,
    "./app-connectors": connectors,
    "./connectors/credentials": { ...credentials, connectorCredentialRepository: () => repository },
    "./index-shared": { ...shared, requireAuth: async () => ({ id: "admin", email: "admin@example.test" }) },
  };
  const app = new Hono();
  route((name) => imports[name] ?? new Proxy({}, { get: () => noop })).registerConnectorRoutes(app);
  const response = await app.fetch(new Request("https://hub.example/api/spaces/space-1/app-connections/slack/credentials", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ regenerate: ["ingressKey"] }) }), {});
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(puts.length, 1);
  assert.deepEqual(Object.keys(puts[0].fields), ["ingressKey"]);
  assert.notEqual(puts[0].fields.ingressKey, "old-key");
  assert.deepEqual(puts[0].policy.generated, ["ingressKey"]);
  assert.ok(puts[0].policy.allowed.includes("botToken"));
});

const permissionRoute = await compileCommonJsSourceModule(new URL("../src/index-routes-connectors.ts", import.meta.url));

function permissionFixture(providerId = "googlecalendar") {
  let agent = false, stored = null;
  const calls = [], noop = () => {};
  const repository = { read: async input => { calls.push(["read", input]); return stored; },
    set: async input => { calls.push(["set", input]); stored = input.mode; return { mode: stored }; } };
  const imports = { "@xmatrix/protocol": protocol, "./app-connectors": connectors,
    "./index-shared": { ...shared, requireAuth: async () => ({ id: "admin", email: "admin@example.test", ...(agent ? { agentRun: {} } : {}) }) },
    "./connectors/credentials": { connectorPermissionRepository: () => repository },
    "./connectors/action-catalog": { connectorActionCatalog: () => new Map(providerId === "github" ? [] : ["create_event", "update_event", "delete_event"].map(id => [id, { executor: {} }])) },
    "./connectors/registry": { connectorProvider: () => ({ actions: {} }) } };
  const app = new Hono(); permissionRoute(name => imports[name] ?? new Proxy({}, { get: () => noop })).registerConnectorRoutes(app);
  return { calls, agent: () => { agent = true; }, request: (method, body) => app.fetch(new Request(`https://hub.test/api/spaces/space/app-connections/${providerId}/policies`, {
    method, ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), {}) };
}
// PostgreSQL owns admin/isolation. HTTP owns rejecting Agent tokens, old Channel
// bodies and unknown scopes rather than interpreting them as wider permission.
test("app permission HTTP exposes one mode and rejects legacy Channel bodies and Agent writes", async () => {
  const f = permissionFixture(); assert.deepEqual(await (await f.request("GET")).json(), { mode: "write", inherited: true });
  for (const mode of ["read", "ask", "write", null]) {
    assert.equal((await f.request("PUT", { mode })).status, 200);
    assert.deepEqual(await (await f.request("GET")).json(), { mode: mode ?? "write", inherited: mode === null });
  }
  const writes = f.calls.length;
  for (const body of [null, [], {}, { mode: "allow" }, { mode: ["write"] }, { mode: "write", channelId: "channel" },
    { mode: "write", actionId: "create_event" }, { scope: "connection", actionIds: ["create_event"], mode: "write" }]) {
    assert.equal((await f.request("PUT", body)).status, 400);
  }
  assert.equal(f.calls.length, writes);
  f.agent(); assert.equal((await f.request("GET")).status, 403);
  assert.equal((await f.request("PUT", { mode: "write" })).status, 403); assert.equal(f.calls.length, writes);
  assert.equal((await permissionFixture("github").request("PUT", { mode: "ask" })).status, 400, "provider without approval execution cannot promise Ask");
});
