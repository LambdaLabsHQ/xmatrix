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
