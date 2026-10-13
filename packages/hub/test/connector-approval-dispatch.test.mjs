import assert from "node:assert/strict";
import test from "node:test";
import * as protocol from "@xmatrix/protocol";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { ProviderRequestError } from "../src/connectors/http.ts";

// The execution boundary must stage ask without calling the provider, and recheck policy
// at dispatch. PostgreSQL's consume-once test cannot detect a dispatcher bypass.
test("Gmail ask stages a request, allow executes, and disallow blocks before provider I/O", async () => {
  let mode = null, writes = 0, prepared = 0, requests = 0, staged = null;
  const announced = [];
  const dependencies = {
    "../workspace-resource-notification": { notifyWorkspaceResource: async (_env, change) => { announced.push(change); } },
    "@xmatrix/protocol": protocol,
    "../app-connectors": { getAppConnectorProvider: () => protocol.APP_CONNECTOR_PROVIDER_MANIFESTS.find(p => p.id === "gmail") },
    "./command-support": { commandScope: async () => ({ spaceId: "s", connectionId: "s:gmail" }),
      withExecution: async (_m, _i, _s, _a, run) => { const r = await run(); return `Gmail send: ${r.status}; ${r.summary}`; },
      publishCommandStatus: async () => {} },
    "./connection-credentials": { connectionCredentials: async () => ({ mailboxes: "[]" }) },
    "./credentials": { connectorActionPolicyRepository: () => ({ mode: async () => mode }),
      connectorActionRequestRepository: () => ({ find: async requestId => staged?.requestId === requestId ? staged : null, create: async input => {
        requests++; assert.deepEqual(input.payload.preview, { from: "from@example.test", to: "to@example.test", subject: "Subject", body: "Body" });
        staged = { requestId: input.requestId, status: "pending" }; return staged;
      } }) },
    "./http": { ProviderRequestError },
  };
  const commands = await loadCommonJsSourceModule(new URL("../src/connectors/connector-commands.ts", import.meta.url),
    name => dependencies[name] ?? {});
  const action = { effect: "write", requires: [], parse: () => ({}), prepare: async () => {
    prepared++; return { from: "from@example.test", to: "to@example.test", subject: "Subject", body: "Body", raw: "private" };
  }, execute: async context => { await context.authorizeWrite(); writes++; return { summary: "sent" }; } };
  const input = { env: {}, channelId: "c", messageId: "m", actorUserId: "human", senderKind: "user" };
  assert.match(await commands.runConnectorAction("gmail", input, "send", action, { target: "to@example.test", text: "Subject\nBody" }), /awaiting approval/);
  assert.deepEqual([writes, prepared, requests], [0, 1, 1]);
  // The staged request is announced, so an admin's open Channel shows it without polling for it.
  const announcement = { spaceId: "s", resource: "connector_action_requests", channelId: "c" };
  assert.deepEqual(announced, [announcement]);
  mode = "allow";
  assert.match(await commands.runConnectorAction("gmail", input, "send", action, { target: "to@example.test", text: "Subject\nBody" }), /awaiting approval/);
  assert.equal(writes, 0, "re-delivery after allow cannot bypass the pending approval");
  mode = "disallow";
  assert.match(await commands.runConnectorAction("gmail", { ...input, messageId: "m2" }, "send", action, { target: "to@example.test", text: "" }), /blocked/);
  assert.equal(writes, 0);
  mode = "allow";
  assert.match(await commands.runConnectorAction("gmail", { ...input, messageId: "m3" }, "send", action, { target: "to@example.test", text: "" }), /completed/);
  assert.equal(writes, 1);
  assert.deepEqual(announced, [announcement], "only a newly staged request changes what waits");
});
