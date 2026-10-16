import assert from "node:assert/strict";
import test from "node:test";
import * as protocol from "@xmatrix/protocol";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { ProviderRequestError } from "../src/connectors/http.ts";
import { commandResult } from "../src/connectors/command-support.ts";

async function dispatcher({ providerId, spaceId, mode, repository, publish = async () => {}, imports = {} }) {
  const dependencies = {
    "@xmatrix/protocol": protocol,
    "../app-connectors": { getAppConnectorProvider: () => protocol.APP_CONNECTOR_PROVIDER_MANIFESTS.find(p => p.id === providerId) },
    "./command-support": { commandResult, commandScope: async () => ({ spaceId, connectionId: `${spaceId}:${providerId}` }),
      withExecution: async (manifest, _input, _scope, action, run) => commandResult(manifest.name, action.id, await run()),
      publishCommandStatus: publish },
    "./credentials": { connectorActionPolicyRepository: () => ({ mode }), connectorActionRequestRepository: () => repository },
    "./http": { ProviderRequestError },
    ...imports,
  };
  return loadCommonJsSourceModule(new URL("../src/connectors/connector-commands.ts", import.meta.url), name => dependencies[name] ?? {});
}

// The execution boundary must stage ask without calling the provider, and recheck policy
// at dispatch. PostgreSQL's consume-once test cannot detect a dispatcher bypass.
test("Gmail ask stages a request, allow executes, and disallow blocks before provider I/O", async () => {
  let mode = null, writes = 0, prepared = 0, requests = 0, staged = null;
  const announced = [];
  const commands = await dispatcher({ providerId: "gmail", spaceId: "s", mode: async () => mode,
    repository: { find: async requestId => staged?.requestId === requestId ? staged : null, create: async input => {
        requests++; assert.deepEqual(input.payload.preview, { from: "from@example.test", to: "to@example.test", subject: "Subject", body: "Body" });
        staged = { requestId: input.requestId, status: "pending" }; return staged;
    } }, imports: {
      "../workspace-resource-notification": { notifyWorkspaceResource: async (_env, change) => { announced.push(change); } },
      "./connection-credentials": { connectionCredentials: async () => ({ mailboxes: "[]" }) },
    } });
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

// Slow provider work must never run during command admission. The repository
// tests own authorization; this dispatcher owns routing both policy modes to a job.
test("X allow uploads freeze input and queue once; only the durable executor performs the transfer", async () => {
  let mode = "allow", stage, writes = 0, authorizations = 0;
  const queued = [], published = [], transferred = [];
  const action = { effect: "write", requires: [], parse: () => ({ account: "@company" }),
    prepare: async () => ({ accountId: "101", accountGeneration: "grant", accountUsername: "company", sourceHash: "frozen" }),
    execute: async (context, prepared) => {
      await context.authorizeWrite(); transferred.push(prepared); writes++;
      return { summary: "uploaded with receipt" };
    } };
  const repository = {
    find: async () => stage?.request ?? null,
    create: async input => {
      stage = { request: { ...input, spaceId: "space", status: "pending" }, payload: input.payload };
      return stage.request;
    },
    startAllowed: async () => { stage.request.status = "executing"; return { request: stage.request, claimed: true }; },
    authorize: async () => { authorizations++; },
  };
  const commands = await dispatcher({ providerId: "x", spaceId: "space", mode: async () => mode, repository,
    publish: async (_manifest, input, lines) => { published.push({ input, lines }); }, imports: {
    "./x-api": { xActionCapability: () => ({}) },
    "./x-upload-executor-do": { enqueueXUpload: async (_env, ref) => { queued.push(ref); } },
    "./actions/x": { X_ACTIONS: { upload_video: action } },
  } });
  const input = { env: {}, channelId: "channel", messageId: "original", actorUserId: "owner", senderKind: "agent", senderId: "instance" };
  const statement = { target: "@company", text: "message/attachment" };
  assert.match(await commands.runConnectorAction("x", input, "upload_video", action, statement), /queued/);
  assert.equal(writes, 0, "admission cannot await the slow provider");
  assert.deepEqual(queued[0], { requestId: stage.request.requestId, spaceId: "space", channelId: "channel" });
  await commands.runConnectorAction("x", input, "upload_video", action, statement);
  assert.equal(writes, 0, "re-delivery can only re-admit the same durable reference");
  assert.deepEqual(queued[1], queued[0]);
  const result = await commands.executeDurableXUpload({}, stage);
  assert.equal(result.status, "completed");
  assert.equal(writes, 1);
  assert.equal(transferred[0].sourceHash, "frozen");
  assert.ok(authorizations > 0);
  assert.equal(published.length, 2, "execution persists its outcome before publishing it");
  await commands.publishDurableXUploadReceipt({}, { ...stage, ...result });
  assert.equal(published[2].input.messageId, "original:upload-result");
  assert.equal(published[2].input.commandMessageId, "original");
  mode = "disallow";
  assert.equal((await commands.executeDurableXUpload({}, stage)).status, "blocked");
  assert.equal(writes, 1, "a current denial prevents provider I/O");
});
