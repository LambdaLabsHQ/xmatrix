import assert from "node:assert/strict";
import test from "node:test";
import * as protocol from "@xmatrix/protocol";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { ConnectorRemedy, ProviderRequestError } from "../src/connectors/http.ts";
import { commandResult } from "../src/connectors/command-support.ts";
import * as metering from "../src/usage-cost-metering.ts";
import { AppControlError } from "../../db/src/app-control.ts";

async function dispatcher({ providerId, spaceId, mode, repository, publish = async () => {}, imports = {} }) {
  const dependencies = {
    "@xmatrix/protocol": protocol,
    "@xmatrix/db": { AppControlError },
    "../app-connectors": { getAppConnectorProvider: () => protocol.APP_CONNECTOR_PROVIDER_MANIFESTS.find(p => p.id === providerId) },
    "./command-support": { commandResult, commandScope: async () => ({ spaceId, connectionId: `${spaceId}:${providerId}` }),
      withExecution: async (manifest, _input, _scope, action, run) => commandResult(manifest.name, action.id, await run()),
      publishCommandStatus: publish },
    "./credentials": { connectorPermissionRepository: () => ({ mode }), connectorActionRequestRepository: () => repository },
    "./http": { ConnectorRemedy, ProviderRequestError },
    "../usage-cost-metering": metering,
    ...imports,
  };
  return loadCommonJsSourceModule(new URL("../src/connectors/connector-commands.ts", import.meta.url), name => dependencies[name] ?? {});
}

// A consumed approval can become stale during the execution's token refresh.
// The dispatch boundary must explain the local refusal without blaming Google,
// leaking arbitrary exceptions, or reaching a provider write.
test("approved actions report stale authority before provider I/O and mask unknown errors", async () => {
  for (const during of ["credentials", "authorization", "preflight", "unknown"]) {
    let checks = 0, writes = 0;
    const failure = new AppControlError(during === "credentials" ? "credential_changed"
      : during === "unknown" ? "unknown" : "action_request_scope_changed", 409, "private diagnostic");
    const commands = await dispatcher({ providerId: "googleads", spaceId: "s", mode: async () => "ask",
      repository: { authorize: async () => {
        checks++;
        if (during !== "preflight" || checks === 2) throw failure;
      } }, imports: {
        "./connection-credentials": { connectionCredentials: async () => {
          if (during === "credentials") throw failure;
          return { oauthToken: "token", customerId: "1234567890" };
        } },
      } });
    const action = { effect: "write", requires: [], parse: () => { throw new Error("must use frozen input"); },
      execute: async context => { await context.authorizeWrite(); writes++; return { summary: "written" }; } };
    const result = await commands.runConnectorAction("googleads", {
      env: {}, channelId: "c", messageId: "m:approved", actorUserId: "owner", senderKind: "user",
    }, "mutate", action, { target: "1234567890", text: "" }, { requestId: "approved", prepared: {} });
    assert.equal(writes, 0);
    assert.doesNotMatch(result, /private diagnostic/);
    assert.match(result, during === "unknown" ? /failed; the provider call failed/
      : /blocked; .*changed.*new approval/i);
  }
});

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
  mode = "write";
  assert.match(await commands.runConnectorAction("gmail", input, "send", action, { target: "to@example.test", text: "Subject\nBody" }), /awaiting approval/);
  assert.equal(writes, 0, "re-delivery after allow cannot bypass the pending approval");
  mode = "read";
  assert.match(await commands.runConnectorAction("gmail", { ...input, messageId: "m2" }, "send", action, { target: "to@example.test", text: "" }), /blocked/);
  assert.equal(writes, 0);
  mode = "write";
  assert.match(await commands.runConnectorAction("gmail", { ...input, messageId: "m3" }, "send", action, { target: "to@example.test", text: "" }), /completed/);
  assert.equal(writes, 1);
  assert.deepEqual(announced, [announcement], "only a newly staged request changes what waits");
});

// Slow provider work must never run during command admission. The repository
// tests own authorization; this dispatcher owns routing both policy modes to a job.
test("X allow uploads freeze input and queue once; only the durable executor performs the transfer", async () => {
  let mode = "write", stage, writes = 0, authorizations = 0;
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
  mode = "read";
  assert.equal((await commands.executeDurableXUpload({}, stage)).status, "blocked");
  assert.equal(writes, 1, "a current denial prevents provider I/O");
});

// The generic Gmail case owns ask/allow/deny. Calendar additionally owns the
// structured preview handoff: falling back to raw JSON hides the real destination.
test("Calendar approval stores the prepared event preview without executing the write", async () => {
  let staged, writes = 0;
  const preview = { change: "update", calendar: "owner@example.com", title: "Changed meeting", start: "2026-10-29", end: "2026-10-30", sendUpdates: "all" };
  const commands = await dispatcher({ providerId: "googlecalendar", spaceId: "s", mode: async () => "ask",
    repository: { find: async () => null, create: async input => { staged = input; return { requestId: input.requestId, status: "pending" }; } },
    imports: { "./connection-credentials": { connectionCredentials: async () => ({ oauthToken: "a" }) },
      "../workspace-resource-notification": { notifyWorkspaceResource: async () => {} } } });
  const action = { effect: "write", requires: ["oauthToken"], parse: () => ({ calendar: "primary" }),
    prepare: async () => ({ calendar: "owner@example.com", preview: JSON.stringify(preview), body: '{"summary":"Changed meeting"}' }),
    execute: async () => { writes++; return { summary: "updated" }; } };
  const result = await commands.runConnectorAction("googlecalendar", { env: {}, channelId: "c", messageId: "m", actorUserId: "owner", senderKind: "agent", senderId: "instance" }, "update_event", action, { target: "primary", text: "event JSON" });
  assert.match(result, /awaiting approval/u);
  assert.deepEqual(staged.payload.preview, preview);
  assert.equal(staged.payload.prepared.calendar, "owner@example.com");
  assert.equal(writes, 0);
});

// Calendar's real action must obey Allow without staging an approval, and its
// destination lookup must not open a race in the final live-policy check.
test("Calendar Allow schedules directly and a policy change during preparation prevents the real write", async () => {
  const { GOOGLE_CALENDAR_ACTIONS } = await import("../src/connectors/actions/google-calendar.ts");
  const { stubFetchResponses } = await import("./support/fetch-responses.mjs");
  for (const revokeDuringPreparation of [false, true]) {
    let mode = null, approvals = 0;
    const commands = await dispatcher({ providerId: "googlecalendar", spaceId: "s", mode: async () => mode,
      repository: { find: async () => null, create: async () => { approvals++; throw new Error("Allow must not ask"); } },
      imports: { "./connection-credentials": { connectionCredentials: async () => ({ oauthToken: "a" }) } } });
    const calendar = { id: "owner@example.com", primary: true, summary: "Work", timeZone: "UTC" };
    const event = { kind: "calendar#event", id: "abcde12345", etag: '"v1"' };
    const fetch = stubFetchResponses([{ body: calendar }, { body: event }], {
      decodeBody: body => body ? JSON.parse(body) : undefined,
      reply: response => {
        if (response.body === calendar && revokeDuringPreparation) mode = "read";
        return new Response(JSON.stringify(response.body));
      },
    });
    try {
      const result = await commands.runConnectorAction("googlecalendar", { env: {}, channelId: "c", messageId: "m", actorUserId: "owner", senderKind: "agent", senderId: "instance" },
        "create_event", GOOGLE_CALENDAR_ACTIONS.create_event, { target: "primary", text: JSON.stringify({ id: event.id, summary: "AI arranged meeting",
          start: { date: "2026-10-29" }, end: { date: "2026-10-30" }, sendUpdates: "none" }) });
      assert.equal(approvals, 0);
      assert.equal(fetch.calls.filter(call => call.method === "POST").length, revokeDuringPreparation ? 0 : 1);
      assert.match(result, revokeDuringPreparation ? /failed|blocked/u : /completed/u);
      if (!revokeDuringPreparation) assert.equal(fetch.calls[1].body.summary, "AI arranged meeting");
    } finally { fetch.restore(); }
  }
});
