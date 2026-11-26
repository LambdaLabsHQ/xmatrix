import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import * as host from "../src/norn-host.ts";
import * as libraries from "../src/norn-libraries.ts";

const load = await compileCommonJsSourceModule(new URL("../src/norn-actions.ts", import.meta.url));
class AppControlError extends Error { constructor(code, status, message) { super(message); this.code = code; this.status = status; } }
class ControlError extends Error { constructor(code, status, message) { super(message); this.code = code; this.status = status; } }
class ProviderRequestError extends Error { constructor(status, message) { super(message); this.status = status; } }

// The connector tests own parsing, freezing and executing an action, and the PostgreSQL tests own the one step from
// approved to executing. This owns what the host makes of each for a program: what it answers, says and waits for.
function fixture({ staged = { status: "pending", requestId: "action-request:1" }, claim = { request: { requestId: "action-request:1" } },
  readResult = { summary: "db: 1 row", url: "https://dash.cloudflare.com/a/d1", data: { rows: [{ failures: 12, kind: "upstream_timeout" }] } },
  executor, known = true } = {}) {
  const calls = [];
  const actions = load(name => ({
    "@xmatrix/db": { AppControlError, ControlError },
    "./app-connectors": { getAppConnectorProvider: id => (id === "x" ? { id: "x", name: "X" } : id === "cloudflare" ? { id: "cloudflare", name: "Cloudflare" } : undefined) },
    "./connectors/http": { ProviderRequestError },
    "./connectors/connector-commands": {
      actionExecutor: (providerId, actionId) => {
        if (!known) return undefined;
        if (executor) return executor(providerId, actionId);
        if (providerId === "x" && actionId === "publish_video") return { effect: "write" };
        if (providerId === "cloudflare" && actionId === "query_database") return { effect: "read" };
        return undefined;
      },
      callConnectorRead: async (providerId, commandInput, actionId, action, statement, _authorize, visibility) => {
        calls.push(["read", { providerId, channelId: commandInput.channelId, actorUserId: commandInput.actorUserId,
          messageId: commandInput.messageId, actionId, action, statement, visibility }]);
        if (readResult instanceof Error) throw readResult;
        return readResult;
      },
      stageHeldAction: async (_env, input) => { calls.push(["stage", input]); return staged; },
      heldAuthorityFailure: error => (error.code === "action_request_forbidden" ? "Current access no longer permits this approval; a Space admin must review it." : undefined),
      announceActionRequests: async (_env, spaceId, channelId) => { calls.push(["announce", spaceId, channelId]); },
    },
    "./connectors/credentials": { connectorActionRequestRepository: () => ({
      claimHeld: async input => { calls.push(["claim", input]); if (claim instanceof Error) throw claim; return claim; },
      withdrawHeld: async input => { calls.push(["withdraw", input]); return ["channel", "channel"]; },
    }) },
    "./connectors/x-upload-executor-do": { enqueueXUpload: async (_env, ref) => { calls.push(["queue", ref]); } },
    "./norn-host": host, "./norn-libraries": libraries,
  })[name]);
  const writeInput = { type: "record", fields: { account: { type: "string", value: "@acme" }, text: { type: "string", value: "Hello" },
    video: { type: "string", value: "message-1/video-1" } } };
  const readInput = { type: "record", fields: { target: { type: "string", value: "trace-db" }, text: { type: "string", value: "SELECT 1" } } };
  const request = (verb, extra = {}) => ({
    id: `request:${verb}`, verb,
    holder: verb === "read" ? "app:cloudflare" : "app:x",
    text: verb === "read" ? "query_database" : "publish_video",
    action: verb === "read"
      ? { app: "cloudflare", name: "query_database", input: readInput, prepared: null }
      : { app: "x", name: "publish_video", input: verb === "prepare" ? writeInput : null, prepared: verb === "prepare" ? null : "request:prepare" },
    ...extra,
  });
  const deliver = (verb, extra = {}) => actions.deliverNornAppRequest({}, { spaceId: "space", channelId: "channel", authorityUserId: "owner",
    request: request(verb, extra.request), requestRef: `r${verb}`, deliveryMessageId: `norn:r${verb}:0`, ...extra });
  return { calls, actions, deliver };
}

test("a prepared action is staged as the command it stands for, held for the program's request", async () => {
  const f = fixture();
  const outcome = await f.deliver("prepare");
  assert.deepEqual(f.calls, [["stage", { channelId: "channel", actorUserId: "owner", messageId: "norn:rprepare:0", providerId: "x",
    actionId: "publish_video", action: { effect: "write" }, heldFor: "rprepare",
    statement: { target: "@acme", text: JSON.stringify({ text: "Hello", video: "message-1/video-1" }) } }]]);
  assert.deepEqual(outcome.held, { dueInMs: 30 * 24 * 60 * 60_000 }, "the host looks again when the approval can no longer be given");
  assert.match(outcome.say, /^X publish_video: awaiting approval\. .*Pending approvals; it runs when the program performs it/u);
});

test("the app's permission, a refusal and a bad input each end the prepare at once with their own reply", async () => {
  const admitted = await fixture({ staged: { status: "approved", requestId: "action-request:1" } }).deliver("prepare");
  assert.deepEqual(admitted.reply, { tag: "Answered", value: { type: "variant", name: "Prepared", args: [{ type: "string", value: "request:prepare" }] } });
  assert.match(admitted.say, /admitted by the app's Read and write permission/u);
  const blocked = await fixture({ staged: { status: "blocked", reason: "post is denied by this app permission" } }).deliver("prepare");
  assert.deepEqual(blocked.reply, { tag: "Revoked" });
  assert.match(blocked.say, /blocked; post is denied by this app permission/u);
  const failed = await fixture({ staged: { status: "failed", reason: "write a nonempty post" } }).deliver("prepare");
  assert.deepEqual(failed.reply, { tag: "Broke", reason: "write a nonempty post" });
  const unknown = fixture({ known: false });
  assert.deepEqual((await unknown.deliver("prepare")).reply, { tag: "Broke", reason: "X publish_video is not an action this host runs" });
  assert.deepEqual(unknown.calls, [], "nothing is staged for an action no provider runs");
});

test("perform takes the one claim on what was approved and hands it to the durable executor", async () => {
  const f = fixture();
  const outcome = await f.deliver("perform", { preparedRef: "rprepare" });
  assert.deepEqual(f.calls, [["claim", { spaceId: "space", channelId: "channel", prepareRef: "rprepare", performRef: "rperform" }],
    ["queue", { requestId: "action-request:1", spaceId: "space", channelId: "channel" }]]);
  assert.deepEqual(outcome, { held: { dueInMs: 30 * 60_000 } });

  const twice = fixture({ claim: { refusal: "It was performed before; a prepared action is performed once" } });
  assert.deepEqual(await twice.deliver("perform", { preparedRef: "rprepare" }),
    { reply: { tag: "Refused", reason: "It was performed before; a prepared action is performed once" } });
  assert.equal(twice.calls.some(call => call[0] === "queue"), false, "what cannot be claimed is never queued");

  const lost = fixture({ claim: new AppControlError("action_request_forbidden", 403, "private") });
  const lostOutcome = await lost.deliver("perform", { preparedRef: "rprepare" });
  assert.deepEqual(lostOutcome.reply, { tag: "Revoked" });
  assert.match(lostOutcome.say, /revoked; Current access no longer permits this approval; a Space admin must review it\./u);
  // A failure that says nothing about authority is not an answer: the delivery is tried again.
  await assert.rejects(fixture({ claim: new Error("connection reset") }).deliver("perform", { preparedRef: "rprepare" }), /connection reset/u);
  assert.deepEqual((await fixture().deliver("perform")).reply, { tag: "Broke", reason: "What was prepared is not known to this host" });
});

test("withdrawing what programs no longer ask tells each conversation's admins once", async () => {
  const f = fixture();
  await f.actions.withdrawNornAppRequests({}, { spaceId: "space", prepareRefs: ["r1", "r2"], ended: true });
  assert.deepEqual(f.calls, [["withdraw", { spaceId: "space", prepareRefs: ["r1", "r2"], approved: true }], ["announce", "space", "channel"]]);
});

test("a read runs at once under the program author's access, returns structured data quietly, and maps denials to Revoked", async () => {
  const f = fixture();
  const ok = await f.deliver("read");
  assert.deepEqual(f.calls, [["read", {
    providerId: "cloudflare", channelId: "channel", actorUserId: "owner", messageId: "norn:rread:0",
    actionId: "query_database", action: { effect: "read" }, statement: { target: "trace-db", text: "SELECT 1" }, visibility: "private",
  }]]);
  assert.equal(ok.say, undefined, "a successful read posts no chat receipt");
  assert.deepEqual(ok.reply, {
    tag: "Answered",
    value: {
      type: "record",
      fields: {
        summary: { type: "string", value: "db: 1 row" },
        url: { type: "variant", name: "Some", args: [{ type: "string", value: "https://dash.cloudflare.com/a/d1" }] },
        rows: {
          type: "list",
          values: [{ type: "record", fields: { failures: { type: "int", value: "12" }, kind: { type: "string", value: "upstream_timeout" } } }],
        },
      },
    },
  });

  const denied = await fixture({ readResult: new ProviderRequestError(403, "only Space members use its connected apps") }).deliver("read");
  assert.deepEqual(denied.reply, { tag: "Revoked" });
  assert.match(denied.say, /^Cloudflare query_database: blocked; only Space members/u);

  const lostChannel = await fixture({ readResult: new ControlError("channel_not_found", 404, "Channel not found") }).deliver("read");
  assert.deepEqual(lostChannel.reply, { tag: "Revoked" });
  assert.match(lostChannel.say, /^Cloudflare query_database: revoked; Channel not found/u);

  const badSql = await fixture({ readResult: new ProviderRequestError(400, "only SELECT queries run here") }).deliver("read");
  assert.deepEqual(badSql.reply, { tag: "Broke", reason: "only SELECT queries run here" });
  assert.match(badSql.say, /^Cloudflare query_database: failed; only SELECT/u);

  const writeAttempt = fixture({ executor: () => ({ effect: "write" }) });
  assert.deepEqual((await writeAttempt.deliver("read")).reply, { tag: "Broke", reason: "Cloudflare query_database is not a read-only action" });
  assert.deepEqual(writeAttempt.calls, [], "write actions never execute via read");

  const callerOnly = fixture({ executor: () => ({ effect: "read", callerOnly: true }) });
  assert.deepEqual((await callerOnly.deliver("read")).reply,
    { tag: "Broke", reason: "Cloudflare query_database is for the caller alone, so a program cannot read it" });
  assert.deepEqual(callerOnly.calls, []);

  await assert.rejects(fixture({ readResult: new Error("socket hang up") }).deliver("read"), /socket hang up/u);
});

// The connector's command runner is loaded by the registry's providers while they are built, so nothing it imports
// may lead back to the registry: a provider would then be built from a module that has not run yet. Each of these
// is where a Worker, a Durable Object or a test starts loading from.
test("the Norn host and the connectors load in any order", () => {
  for (const entry of ["connectors/connector-commands.ts", "connectors/x-upload-executor-do.ts", "connectors/registry.ts",
    "connectors/platform-providers.ts", "norn-actions.ts", "norn-programs.ts", "index-routes-connector-approvals.ts"]) {
    const loaded = spawnSync(process.execPath, ["--import", "tsx", "--import", "./test/support/platform-preload.mjs", "--input-type=module",
      "-e", `await import(${JSON.stringify(new URL(`../src/${entry}`, import.meta.url).href)});`],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
    assert.equal(loaded.status, 0, `${entry} does not load by itself:\n${loaded.stderr.split("\n").slice(0, 6).join("\n")}`);
  }
});
