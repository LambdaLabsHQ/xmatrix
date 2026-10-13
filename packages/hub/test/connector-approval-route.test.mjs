import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import * as protocol from "@xmatrix/protocol";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

const load = await compileCommonJsSourceModule(new URL("../src/index-routes-connector-approvals.ts", import.meta.url));

// PostgreSQL tests own admin/consume-once behavior. This HTTP boundary owns rejecting
// Agent credentials and caller-supplied replacement content before reaching that authority.
function fixture() {
  let agent = false;
  const calls = [];
  const frozen = { messageId: "original", senderKind: "user", statement: { target: "approved@example.test", text: "Approved subject\nApproved body" },
    prepared: { to: "approved@example.test", body: "Approved body", raw: "frozen-mime" } };
  const repository = {
    pending: async input => { calls.push(["pending", input]); return []; },
    decide: async input => { calls.push(["decide", input]); return { claimed: true, payload: frozen,
      request: { requestId: "request", providerId: "gmail", actionId: "send", requestedBy: "original-owner" } }; },
    settle: async (...args) => { calls.push(["settle", ...args]); },
  };
  const imports = {
    "@xmatrix/protocol": protocol,
    "./app-connectors": { getAppConnectorProvider: () => ({ id: "gmail", name: "Gmail" }) },
    "./connectors/command-support": { publishCommandStatus: async () => {} },
    "./index-shared": { requireAuth: async () => ({ agentRun: agent }), requireHumanAuth: () => ({ id: "admin" }),
      requestErrorStatus: () => 500, readBoundedRequestBody: async (request, max) => {
        const bytes = new Uint8Array(await request.arrayBuffer()); return bytes.length <= max ? bytes : undefined;
      } },
    "./spaces": { getChannel: async () => ({ channel: { spaceId: "space" } }) },
    "./connectors/credentials": { connectorActionRequestRepository: () => repository },
    "./connectors/registry": { connectorProvider: () => ({ id: "gmail" }) },
    "./connectors/action-catalog": { connectorActionCatalog: () => new Map([["send", { executor: {} }]]) },
    "./connectors/connector-commands": { runConnectorAction: async (...args) => { calls.push(["run", ...args]); return "Gmail send: completed; sent"; } },
  };
  const app = new Hono(); load(name => imports[name]).registerConnectorApprovalRoutes(app);
  return { calls, frozen, agent: () => { agent = true; }, request: (method, body) => app.request(
    method === "GET" ? protocol.HUB_ROUTES.channel_connector_action_requests("channel")
      : protocol.HUB_ROUTES.channel_connector_action_request("channel", "request"),
    { method, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }, {}) };
}

test("Agent credentials cannot read private approval previews or approve any request", async () => {
  const f = fixture(); f.agent();
  assert.equal((await f.request("GET")).status, 403);
  assert.equal((await f.request("POST", { decision: "allow" })).status, 403);
  assert.deepEqual(f.calls, []);
});

test("a decision cannot replace the recipient, text, or frozen provider input", async () => {
  const f = fixture();
  for (const body of [{ decision: "allow", prepared: { to: "evil@example.test" } }, { decision: "allow", text: "changed" },
    { decision: "approve" }, {}, { decision: "allow", providerId: "slack" }]) {
    assert.equal((await f.request("POST", body)).status, 400);
  }
  assert.deepEqual(f.calls, []);
  const response = await f.request("POST", { decision: "allow" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(f.calls[0], ["decide", { channelId: "channel", spaceId: "space", actorUserId: "admin", requestId: "request", allow: true }]);
  const run = f.calls.find(call => call[0] === "run");
  assert.equal(run[2].actorUserId, "original-owner", "approval does not substitute the admin's mailbox");
  assert.equal(run[2].messageId, "original:approved");
  assert.deepEqual(run[5], f.frozen.statement);
  assert.deepEqual(run[6], { requestId: "request", prepared: f.frozen.prepared });
  assert.deepEqual(f.calls.at(-1), ["settle", "request", "completed"]);
});
